# zk-vote Agent Guide

## Project Snapshot

`zk-vote` is a zero-knowledge voting project that currently has a working
Node/Express backend, React frontend, Solidity contracts, Circom/snarkjs ZK
artifacts, and a newly scaffolded Rust backend for the planned migration.

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

The existing Node backend is still the active app surface. The Rust backend is
an initial scaffold and must not replace Node routes until API parity is built
and verified.

## Top-Level Structure

```text
.
├── contracts/              Solidity VotingTally and generated verifier contracts
├── frontend/               React app and browser-side proof generation worker
├── server/                 Current Node/Express backend
├── rust-backend/           New Rust backend migration scaffold
├── docs/                   Project plan and API compatibility notes
├── scripts/                Hardhat deploy scripts and local/GCP setup scripts
├── infra/                  GCP infra support files
├── test/                   Hardhat and backend helper tests
├── docker-compose.yml      Local Postgres + Redis development services
└── .env.example            Local/Rust backend environment template
```

## Current Node Backend

The active backend entrypoint is `server/index.js`.

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

Important helpers:

```text
server/utils/merkle.js              Merkle tree, voter registration lock, final snapshot
server/utils/redisLock.js           Redis compare-delete distributed lock
server/utils/submissionTickets.js   Redis-backed single-use submit tickets
server/utils/submitValidation.js    submit proof/publicSignals validation
server/utils/finalizationState.js   Redis marker for on-chain configured elections
server/utils/email.js               shared email normalization
```

State-sensitive invariants:

- Registration and finalize share the same election Redis lock.
- Submit tickets are bound to `electionId`, `merkleRoot`, and `nullifierHash`.
- `/submit` must reject election/root/nullifier/candidate mismatches before relaying.
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

ZK files live under `server/zkp/`.

```text
server/zkp/circuits/
server/zkp/build_<depth>_<candidates>/
server/zkp/setUpZk.sh
server/zkp/prove.sh
```

Production v1 remains Circom/snarkjs. Noir is planned as a POC only.

## Rust Backend Scaffold

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

Current Rust API:

```text
GET /healthz
GET /readyz
```

`/readyz` verifies:

- config loaded
- Postgres connection works
- Redis responds to `PING`

Planned migration order:

1. shared config, errors, tracing, OpenAPI
2. Supabase JWT/JWKS auth middleware
3. DB repositories and domain services
4. read-only election APIs
5. create/add voters/register APIs
6. proof ticket and submit APIs
7. finalize/relayer workers
8. frontend API client switch

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
bash scripts/gcp/zkvote-staging-setup.sh
```

The script is intended to be idempotent for existing resources. If the Cloud SQL
user already exists and no `DB_PASSWORD` is provided, it skips adding a new
database-url secret version to avoid writing an invalid password.

Required staging secrets follow the `zkvote-staging-*` prefix:

```text
zkvote-staging-database-url
zkvote-staging-redis-url
zkvote-staging-supabase-url
zkvote-staging-supabase-jwks-url
zkvote-staging-sepolia-rpc-url
zkvote-staging-relayer-private-key
zkvote-staging-secret-salt
zkvote-staging-artifact-bucket
```

## Verification Commands

Node/backend syntax examples:

```bash
node --check server/routes/finalizeVote.js
node --check server/routes/submitZk.js
node --check server/utils/merkle.js
bash -n server/zkp/setUpZk.sh
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
