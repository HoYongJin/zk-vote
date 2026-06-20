# zk-vote Agent Guide

## Project Snapshot

`zk-vote` is a zero-knowledge voting project built on a **Rust backend (the sole
API surface)**, a React frontend, Solidity contracts, and Circom/snarkjs ZK
artifacts (`zk/`). The Rust backend has **full route parity** with the deleted
legacy Node API (Phases 4–15 + the Phase-6.5 Node deletion are done on this
branch, with a Phase 5–13 integration-test suite verified green locally).

The intended target architecture is:

```text
TypeScript React frontend
  -> Rust API backend
    -> Postgres
    -> Redis
    -> ZK artifact store
    -> Ethereum RPC / relayer
      -> Solidity VotingTally + Groth16 verifier
```

The existing Node backend is still the **active app surface** — not because the
Rust backend is unfinished, but because the GCP staging deploy (Phase 16),
residual privacy measurements (Phase 18), and the live migration cutover +
data ETL (Phase 19) have **not been executed**. Nothing runs on real GCP infra
yet. Do not switch the frontend to the Rust API or remove Node routes until that
staged cutover is done and verified.

## Top-Level Structure

```text
.
├── contracts/              Solidity VotingTally and generated verifier contracts
├── frontend/               React app and browser-side proof generation worker
├── rust-backend/           Rust backend (axum) — the sole API surface
├── zk/                     ZK toolchain: VoteCheck.circom, build_*/, setUpZk.sh (relocated from server/zkp in Phase 6.5)
├── docs/                   Project plan and API compatibility notes
├── scripts/                Hardhat deploy + ETL/migration + local/GCP setup scripts
├── infra/                  GCP infra support files
├── test/                   Hardhat contract/circuit/Poseidon/ETL helper tests
├── docker-compose.yml      Local Postgres + Redis development services
└── .env.example            Local/Rust backend environment template
```

## API Surface (Rust backend)

The backend entrypoint is `rust-backend/crates/api/src/main.rs` (axum). The legacy
Node `server/` was deleted in Phase 6.5; these routes are now served by Rust at full
parity.

Important routes:

```text
POST /api/elections/set
POST /api/elections/:election_id/setZkDeploy
POST /api/elections/:election_id/voters
POST /api/elections/:election_id/register
POST /api/elections/:election_id/finalize
POST /api/elections/:election_id/proof
POST /api/elections/:election_id/submit
POST /api/elections/:election_id/complete
GET  /api/elections/registerable
GET  /api/elections/finalized
GET  /api/elections/completed
```

Important helpers (Rust crates — the Node `server/utils/*` equivalents were deleted):

```text
crates/zkp        bit-exact Poseidon + FixedMerkleTree (root, voter snapshot)
crates/domain     state machine, registration/finalization/submit validation
crates/api tickets.rs   Redis-backed single-use submit tickets (binds election+root only)
crates/db         sqlx repos (elections, voters, admins, submission_tickets, ...)
crates/chain      alloy relayer: deploy, configureElection, receipt polling
```

State-sensitive invariants:

- Registration and finalize share the same election Redis lock.
- Submit tickets are bound to `electionId` and `merkleRoot` only. They must
  not bind `nullifierHash`, because `/proof` must not learn or store the
  voter's nullifier under the post-H2 client-held-secret privacy model.
- `/submit` must reject election/root/candidate mismatches and verify the
  nullifier against the proof's public signals before relaying — the ticket
  itself never carries the nullifier (post-H2 / AR-H5 privacy model).
- `VotingTally.configureElection()` is the preferred one-shot finalize path.
- On-chain configured elections must not accept additional voter registration.
- `/complete` must not mark an election completed before `voting_end_time`.

Route compatibility for the Rust migration is tracked in:

```text
docs/API_COMPATIBILITY.md
```

## Solidity / ZK

Contracts live in `contracts/`.

```text
contracts/VotingTally.sol
contracts/Groth16Verifier*.sol
```

Current contract direction:

- `VotingTally` stores immutable election config, one-time root/period config,
  used nullifiers, and candidate vote counts.
- Generated Groth16 verifier contracts are produced by Circom/snarkjs setup.
- Hardhat is still the current contract test/deploy toolchain.

ZK files live under `zk/`.

```text
zk/circuits/
zk/build_<depth>_<candidates>/
zk/setUpZk.sh
zk/prove.sh
```

Production v1 remains Circom/snarkjs. Noir is planned as a POC only.

## Rust Backend

Rust workspace root:

```text
rust-backend/
├── Cargo.toml
├── migrations/0001_initial.sql
└── crates/
    ├── api/
    ├── domain/
    ├── db/
    ├── chain/
    ├── zkp/
    └── workers/
```

Current Rust API (full parity — see `rust-backend/crates/api/src/routes/mod.rs`):

```text
GET  /healthz                                  GET  /readyz
GET  /api/me                                   GET  /api/admin/ping
GET  /api/elections/registerable|finalized|completed
POST /api/elections/set                        POST /api/management/addAdmins
POST /api/elections/:id/setZkDeploy            POST /api/elections/:id/voters
POST /api/elections/:id/register               POST /api/elections/:id/finalize
POST /api/elections/:id/complete               GET  /api/elections/:id/artifact-info
GET  /api/zkp-files/*artifact_path             POST /api/elections/:id/proof
POST /api/elections/:id/submit   (anonymous — no auth extractor, by design)
```

`/readyz` verifies config loaded, Postgres connection works, and Redis responds
to `PING`.

Single binary: only `zkvote-api` is built. `crates/workers` is a **placeholder
stub** (a lone `WorkerError` enum) — finalize and deploy run **inline** in the
request handlers under Redis leases + pg advisory locks; `finalization_jobs` is
an audit/retry trail, not a consumed queue.

Remaining migration work (executable, not yet done):

1. Phase 16 — stand up GCP staging (Cloud Run / Cloud SQL / Memorystore) and
   measure its gates. **Incurs cost; needs explicit user approval.**
2. Phase 18 — residual privacy measurements (AR-M1 unlinkable-auth decision,
   AR-M2 timing correlation, AR-H1 public-beacon ceremony for a staging election).
3. Phase 19 — live Supabase→Postgres ETL, rollback rehearsal, and one full Rust
   staging-election E2E (the Milestone E exit criterion).
4. Phase 20 — production readiness (backup/restore, load test, monitoring).

## Database

Local DB is Postgres 16 via Docker Compose.

```text
database: zkvote
user: zkvote
password: zkvote_dev_password
port: 5432
```

Initial migration:

```text
rust-backend/migrations/0001_initial.sql
rust-backend/migrations/0002_node_api_compatibility.sql
```

Tables:

```text
elections
admins
admin_invitations
voters
submission_tickets
vote_submissions
finalization_jobs
zk_artifacts
contract_deployments
```

Key constraints:

- `elections.state` is constrained to explicit lifecycle values.
- `voters` has `unique(election_id, email)`.
- `voters` has `unique(election_id, user_id)`.
- `vote_submissions` has `unique(election_id, nullifier_hash)`.
- Merkle depth is limited to `1..20`.

## Local Development

Start local infrastructure:

```bash
bash scripts/local/smoke.sh
```

This starts and checks:

```text
zkvote-postgres -> localhost:5432
zkvote-redis    -> localhost:6379
```

Apply local migration:

```bash
bash scripts/local/migrate.sh
```

Run Rust API locally:

```bash
cd rust-backend
APP_BIND_ADDR=127.0.0.1:18080 \
DATABASE_URL=postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote \
REDIS_URL=redis://localhost:6379 \
ARTIFACT_STORE=local \
cargo run -p zkvote-api
```

Check endpoints:

```bash
curl http://127.0.0.1:18080/healthz
curl -i http://127.0.0.1:18080/readyz
```

## GCP Staging

Staging defaults:

```text
project: scopeball-registry-poc-g
region: asia-northeast3
bucket: zkvote-staging-artifacts-scopeball-registry-poc-g
cloud sql: zkvote-staging-pg
redis: zkvote-staging-redis
vpc connector: zkvote-staging-vpc
service account: zkvote-staging-api@scopeball-registry-poc-g.iam.gserviceaccount.com
```

Provision/update staging:

```bash
CONFIRM_COSTS=yes bash scripts/gcp/zkvote-staging-setup.sh
```

The script is intended to be idempotent for existing resources. It provisions
separate Cloud SQL users for runtime (`SQL_APP_USER`, default `zkvote_app`) and
migrations (`SQL_MIGRATOR_USER`, default `zkvote_migrator`). If either user
already exists and no matching password env is provided
(`SQL_APP_PASSWORD`/legacy `DB_PASSWORD`, or `SQL_MIGRATOR_PASSWORD`), it skips
adding a new database-url secret version to avoid writing an invalid password.
Manual SQL passwords used by this script must be URL-safe
(`[A-Za-z0-9._~-]`), otherwise the script refuses to write a broken
`DATABASE_URL` secret.
Apply `rust-backend/db/roles.sql` with `psql -v migrator_password=... -v
app_password=...` after migrations so the runtime role has DML-only access.

Required staging secrets follow the `zkvote-staging-*` prefix:

```text
zkvote-staging-database-url
zkvote-staging-migrator-database-url
zkvote-staging-redis-url
zkvote-staging-supabase-url
zkvote-staging-supabase-jwks-url
zkvote-staging-sepolia-rpc-url
zkvote-staging-relayer-private-key
zkvote-staging-owner-private-key
zkvote-staging-artifact-bucket
```

Deploying the Rust API to staging requires
`OWNER_PRIVATE_KEY_SECRET=zkvote-staging-owner-private-key`; the deploy script
also verifies that the secret has a latest version before mounting it.

## Verification Commands

JS/shell syntax gates (mirror CI — `server/` is gone):

```bash
find scripts test -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
find scripts zk -name '*.sh' -print0 | xargs -0 -n1 bash -n
```

Hardhat:

```bash
npx hardhat test --no-compile
npx hardhat test
```

Rust:

```bash
cd rust-backend
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

Local infra:

```bash
bash scripts/local/smoke.sh
docker compose ps
```

Toolchain:

```bash
bash scripts/local/check-toolchain.sh
```

Known current toolchain gap:

- `circom` missing globally
- `snarkjs` missing globally, but npm dependency may be available through `npx`
- `nargo` missing globally

## Agent Working Rules

- Do not remove or rewrite the Node backend until Rust route parity is explicit.
- Do not commit real secret values. Use `.env`, Secret Manager, or placeholders.
- Do not broaden GCP IAM beyond resource-scoped permissions without a clear reason.
- Preserve existing dirty user changes unless explicitly asked to revert them.
- Prefer state-machine-safe changes over nullable-column inference.
- For finalization and relayer work, test DB/on-chain partial failure behavior.
- For any ZK artifact change, verify all of `.sol`, `.wasm`, `.zkey`, and
  verification key are present and match the circuit version.
