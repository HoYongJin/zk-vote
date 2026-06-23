# zk-vote

Zero-knowledge voting project with a Rust backend (the sole API surface), a
React frontend, a Circom/Groth16 proof pipeline, and Solidity contracts. The
legacy Node/Express backend was removed in Phase 6.5 — Rust is canonical.

## Current Architecture

```text
React frontend
  -> Rust API backend (axum; sole backend, legacy Node deleted in Phase 6.5)
    -> PostgreSQL (Cloud SQL target; local Docker Postgres for dev)
    -> Redis locks and submission tickets
    -> Circom/snarkjs artifacts (zk/)
    -> Solidity VotingTally + Groth16 verifier
```

The Rust backend implements the full route surface (16 routes) with a Phase
5–13 integration-test suite, verified green locally (db repos + the real-proof
vote pipeline E2E). The remaining work is the **cloud rollout** — GCP staging
infra, the Supabase Auth→GCP Identity Platform swap, and the Supabase→Cloud SQL
ETL (see `docs/PROJECT_PLAN.md`). Nothing runs on real GCP infrastructure yet;
this is local-demo/dev-only.

**Frontend hosting:** Firebase Hosting (`firebase.json`,
`.github/workflows/deploy-frontend-firebase.yml`), alongside the GCP backend. The
legacy AWS S3/CloudFront CD has been removed. The deployed origin must be allowed
in the Cloud Run `CORS_ALLOWED_ORIGINS`.

## Important Docs

- `AGENT.md`: repository map and working rules for agents.
- `docs/PROJECT_PLAN.md`: end-to-end migration and production-readiness plan.
- `docs/API_COMPATIBILITY.md`: current Node API behavior to preserve during Rust
  migration.

## Local Infrastructure

Start local Postgres and Redis:

```bash
bash scripts/local/smoke.sh
```

Local defaults:

```text
Postgres: postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote
Redis:    redis://localhost:6379
```

Apply Rust migrations to local Postgres:

```bash
bash scripts/local/migrate.sh
```

## ZK Toolchain

Check what is installed (informational, never fails):

```bash
CIRCOM_BIN=/path/to/circom bash scripts/local/check-toolchain.sh
```

- `circom`: build from source (https://docs.circom.io) and either put it on
  `PATH` or export `CIRCOM_BIN=/path/to/circom` (honored by `setUpZk.sh` and
  the `/setZkDeploy` preflight).
- `snarkjs`: the repo always uses the local `node_modules/.bin/snarkjs`; do
  not install it globally.
- Powers of Tau: `.ptau` files are gitignored and must be provisioned
  per environment with checksum verification (audit M2):

```bash
bash scripts/local/fetch-ptau.sh 12   # Merkle depth <= 5 (build_4_5/build_5_4)
bash scripts/local/fetch-ptau.sh 16   # depth <= 10
bash scripts/local/fetch-ptau.sh 20   # depth <= 20
```

The script downloads from the official mirror and verifies the blake2b-512
hash published in the snarkjs README; it fails closed on any mismatch.

- Noir (`nargo`) is POC-only: install via `noirup` if you work on the POC,
  but nothing in the production path may depend on it.

## Environment Files

- Root `.env` (see `.env.example`): the Rust backend + Hardhat
  (`DATABASE_URL`, `REDIS_URL`, `SUPABASE_JWKS_URL`, `SEPOLIA_RPC_URL`,
  `PRIVATE_KEY`/`RELAYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY`).
- `scripts/migration/.env` (gitignored): Supabase service-role creds for the
  deploy/ETL tooling only (the legacy `server/.env` was removed in Phase 6.5).

## Verification

Node and scripts:

```bash
find scripts test -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
find scripts zk -name '*.sh' -print0 | xargs -0 -n1 bash -n
```

Contracts and helper tests:

```bash
npx hardhat test --no-compile
```

Rust:

```bash
cd rust-backend
cargo fmt --check
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

## Notes

- Production ZK path is Circom/Groth16.
- Noir is reserved for POC work and must not affect production artifact
  selection.
- Submit remains anonymous and is authorized by a short-lived, single-use
  Redis submission ticket bound to the election and Merkle root only — the
  server never learns a voter's nullifier before submit (post-audit privacy
  model, audit H2 / AR-H5).
- Voter secrets are generated and kept client-side (localStorage); the server
  stores only the Poseidon commitment `H(secret)`.
- Do not commit real secrets. Use `.env` locally and Secret Manager in staging.
