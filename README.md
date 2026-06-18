# zk-vote

Zero-knowledge voting project with the current Node/Express backend, React
frontend, Circom/Groth16 proof pipeline, Solidity contracts, and a Rust backend
that has reached full API route parity and is awaiting a staged cutover.

## Current Architecture

```text
React frontend
  -> Node/Express backend
    -> Supabase tables/auth
    -> Redis locks and submission tickets
    -> Circom/snarkjs artifacts
    -> Solidity VotingTally + Groth16 verifier
```

The backend target is Rust with PostgreSQL, Redis, GCS artifact storage, and a
typed alloy relayer layer. The Rust backend already implements the full route
surface (16 routes) with a Phase 5–13 integration-test suite on the feature
branch. The Node backend remains the **active API** only until the GCP staging
deploy and live migration cutover are executed — not because Rust is unfinished.
Nothing runs on real GCP infrastructure yet; this is local-demo/dev-only.

**Frontend hosting:** the committed frontend CD currently targets legacy AWS
S3/CloudFront (`frontend/buildspec.yml`, `.github/workflows/deploy-frontend.yml`),
while the backend moves to GCP. The post-cutover frontend hosting target is an
open decision (see `docs/TECH_STACK.md` §6).

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

- Root `.env` (see `.env.example`): Rust backend + Hardhat
  (`SEPOLIA_RPC_URL`, `PRIVATE_KEY`, `ETHERSCAN_API_KEY`).
- `server/.env` (see `server/.env.example`): the ONLY file the Node API
  loads — Supabase keys, Redis, relayer key, `PORT`, `CIRCOM_BIN`.

## Verification

Node and scripts:

```bash
find server scripts test -name '*.js' -not -path 'server/node_modules/*' -print0 | xargs -0 -n1 node --check
find scripts server/zkp -name '*.sh' -print0 | xargs -0 -n1 bash -n
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
