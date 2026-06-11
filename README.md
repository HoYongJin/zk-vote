# zk-vote

Zero-knowledge voting project with the current Node/Express backend, React
frontend, Circom/Groth16 proof pipeline, Solidity contracts, and a Rust backend
migration scaffold.

## Current Architecture

```text
React frontend
  -> Node/Express backend
    -> Supabase tables/auth
    -> Redis locks and submission tickets
    -> Circom/snarkjs artifacts
    -> Solidity VotingTally + Groth16 verifier
```

The planned backend target is Rust with PostgreSQL, Redis, GCS artifact storage,
and a typed relayer/worker layer. The Node backend remains the active API until
Rust route parity is verified.

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
- Submit remains anonymous and is authorized by a short-lived Redis submission
  ticket bound to election, Merkle root, and nullifier hash.
- Do not commit real secrets. Use `.env` locally and Secret Manager in staging.
