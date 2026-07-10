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

The Rust backend implements the current route surface (22 routes, including the
anonymous vote path and GOV-1 admin-governance routes). Phase 5–13 integration
tests were verified green locally in the prior hardening pass (db repos + the
real-proof vote pipeline E2E). The active cloud deployment is production-only in
`zkvote-prod-hhyyj`; deployment and verification gates are in `scripts/verify/`.

**Deployment:** a successful CI run for `main` triggers
`.github/workflows/deploy-production.yml`, which deploys both Cloud Run and
Firebase Hosting in `zkvote-prod-hhyyj`. The deployed origin must be allowed in
the Cloud Run `CORS_ALLOWED_ORIGINS`.

## Important Docs

- `AGENTS.md`: repository map and working rules for agents.
- `Architecture.md`: high-level source-backed architecture map.
- `docs/E2E_FLOW.md`: current code-backed voting flow and route map.
- `docs/PRODUCTION_READINESS.md`: production operational constraints and evidence.

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
bash scripts/local/fetch-ptau.sh 12   # Merkle depth <= 5
bash scripts/local/fetch-ptau.sh 16   # depth <= 10
bash scripts/local/fetch-ptau.sh 20   # depth <= 20
```

The script downloads from the official mirror and verifies the blake2b-512
hash published in the snarkjs README; it fails closed on any mismatch.

- Noir (`nargo`) is POC-only: install via `noirup` if you work on the POC,
  but nothing in the production path may depend on it.

## Environment Files

- Root `.env` (see `.env.example`): the Rust backend, Foundry/local chain tooling,
  and GCP deploy scripts
  (`DATABASE_URL`, `REDIS_URL`, `SUPABASE_JWKS_URL`, `SEPOLIA_RPC_URL`,
  `RELAYER_PRIVATE_KEY`, `OWNER_PRIVATE_KEY`).
- `scripts/migration/.env` (gitignored): Supabase service-role creds for the
  deploy/ETL tooling only (the legacy `server/.env` was removed in Phase 6.5).

## Verification

TypeScript and scripts:

```bash
npm run typecheck && npm test
find scripts zk -name '*.sh' -print0 | xargs -0 -n1 bash -n
```

Script roles:

```text
scripts/iac/        scripted GCP/GitHub infrastructure setup
scripts/cicd/       repeatable deploy and CI/CD support
scripts/verify/     read-only verification gates and E2E smoke checks
scripts/migration/  cutover-only Supabase -> GCP migration tools
scripts/local/      local developer bootstrap
```

Contracts:

```bash
forge fmt --check && forge build && forge test
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
- Do not commit real secrets. Use `.env` locally and Secret Manager in production.
