# CLAUDE.md — zk-vote project guide

> Loaded into every Claude Code session. Keep it short, current, and true.
> Deep detail lives in `AGENT.md` (repo map), `docs/` (plan, security, data model),
> `docs/TECH_STACK.md` (stack + rationale), and `docs/DOC_DEBT.md` (known stale docs).

## What this is

`zk-vote` is an **anonymous zero-knowledge voting system**. A registered voter proves
membership in a Merkle tree of eligible voters and casts a 1-hot vote inside a
Circom/Groth16 circuit; an on-chain `VotingTally` contract verifies the proof,
enforces one-vote-per-voter via a nullifier, and tallies results. The server never
learns who voted for what.

The project is **mid-migration**: a legacy **Node/Express + Supabase + Redis** backend
(`server/`) is being replaced by a new **Rust** backend (`rust-backend/`).

## Current status — read this before assuming anything

- The Rust backend is **NOT a scaffold**. It has reached **full route parity** with the
  Node API (16 routes incl. anonymous `submit`, `proof`, `finalize`, `setZkDeploy`,
  artifacts, admin/voter lists) plus a large Phase 5–13 integration-test suite.
  Phases 0–15, 17, 18 of the 20-phase plan are **done on this branch**.
- The **Node backend is still the live API surface** — not because Rust is unfinished,
  but because the **GCP staging deploy (Phase 16), residual privacy measurements
  (Phase 18: AR-M1/AR-M2/AR-H1 beacon), and the live cutover+ETL (Phase 19) have not been
  executed**. Nothing runs on real GCP infra yet; the system is local-demo/dev-only.
- All work lives on branch `codex/phase1-c1-h1-circuit-contract-v2` (badly misnamed — it
  carries all 20 phases, ~34 commits ahead of `main`). **`main` is intentionally frozen**
  because a push to `main` can trigger the legacy AWS auto-deploy (now `workflow_dispatch`-gated, audit M11).
- There is a large **uncommitted working tree** (prior-agent WIP: supersede redesign,
  field-element helpers, submission jitter, Rust `artifacts` route, ETL, GCP cloudbuild,
  frontend tests). **Preserve it — do not revert it.**

## Architecture

```
Current (live):  React → Node/Express → Supabase(Postgres+Auth) + Redis + Circom/snarkjs → Solidity VotingTally + Groth16Verifier
Target:          React → Rust API (axum) → Cloud SQL(Postgres) + Memorystore(Redis) + GCS artifacts + alloy relayer → VotingTally + Groth16Verifier
```

Rust workspace crates: `api` (axum routes), `domain` (services + state machine),
`db` (sqlx repos), `chain` (alloy), `zkp` (bit-exact Poseidon/Merkle), `workers`
(**placeholder stub only** — finalize/deploy run inline in request handlers, guarded
by Redis leases + pg advisory locks; `finalization_jobs` is an audit/retry trail, not a
consumed queue).

## Tech stack (summary — full rationale in `docs/TECH_STACK.md`)

- **Backend:** Rust — axum 0.7, tokio 1, sqlx 0.8 (postgres, **rustls**, compile-checked),
  redis 0.27, alloy 1, jsonwebtoken 9 (Supabase JWKS), light-poseidon 0.2 + ark-bn254 0.4,
  utoipa 5, tower-http 0.6, reqwest 0.12 (rustls).
- **Contracts:** Solidity 0.8.20, Hardhat 2.24 + hardhat-toolbox 5 (no Ignition).
- **ZK:** Circom 2.2.3 + snarkjs 0.7.5, Groth16 over BN254. `nPublic = 4`:
  `[root_out, vote_index, nullifier_hash, election_id]`.
- **Frontend:** React 19, Create React App (react-scripts 5), Redux Toolkit 2.9,
  axios 1.12, @supabase/supabase-js 2.74, poseidon-lite 0.3.0 + snarkjs (browser proving).
- **Data:** PostgreSQL (Cloud SQL target), Redis (Memorystore target). Two-role DB
  privilege model (`zkvote_migrator` DDL / `zkvote_app` DML-only).
- **Infra:** GCP Cloud Run / Cloud SQL / Memorystore / Secret Manager / Artifact Registry /
  VPC connector; GitHub Actions CI. Legacy frontend CD still targets AWS S3/CloudFront
  (**hosting decision post-cutover is OPEN**).

## Security invariants — DO NOT BREAK

1. **Anonymous submit.** `POST /…/submit` must never require a JWT. It is authorized by a
   single-use Redis **submission ticket** issued by the authenticated `/proof` route.
2. **Ticket binds `(election_id, merkle_root)` ONLY — never the nullifier** (AR-H5/H2).
   If the server learns the nullifier at `/proof` time, identity→nullifier→candidate
   linkage is restored and anonymity collapses.
3. **Server never holds plaintext secret or nullifier** (H2). Voter secret is generated
   and stored client-side (localStorage); the server stores only the Poseidon commitment
   `H(secret)` in `voters.user_secret_commitment`. (`SECRET_SALT` was removed; the
   `user_secret` column was dropped — docs that say otherwise are stale.)
4. **On-chain is the final judge.** Nullifier uniqueness + `election_id` binding (audit C1)
   + boolean-constrained Merkle path indices (audit H1) are enforced in the circuit and
   `VotingTally`. The DB `unique(election_id, nullifier_hash)` is defense-in-depth only.
5. **Owner key ≠ relayer key** (AR-M4). `OWNER_PRIVATE_KEY` (cold) holds
   `configureElection` rights; the hot relayer EOA only pays gas. Conflating them lets a
   relayer-key leak front-run `configureElection` and permanently freeze an election.
6. **Trusted setup must be beacon-finalized** (AR-H1, drand) with `snarkjs zkey verify`
   gated for any staging/production election.
7. **Poseidon must be bit-identical** across circuit, frontend (poseidon-lite), server
   (circomlibjs), and Rust (light-poseidon) — a 1-bit divergence invalidates every proof.

**Accepted v1 risks (not bugs):** on-chain public running tally + per-vote choice;
receipt-freeness is broken (a secret-holder can prove their vote → vote-buying); residual
global-passive-observer timing correlation (AR-M2). Don't "fix" these without scope sign-off.

## Build / test / verify

```bash
# Rust
cd rust-backend && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
# DB-backed Rust integration tests need local infra first:
bash scripts/local/smoke.sh && bash scripts/local/migrate.sh   # docker Postgres+Redis
cargo test -p zkvote-api -- --ignored                          # then the #[ignore] suite

# Contracts + JS helpers
npx hardhat test --no-compile
# JS/shell syntax gates (mirror CI)
find server scripts test -name '*.js' -not -path 'server/node_modules/*' -print0 | xargs -0 -n1 node --check
find scripts server/zkp -name '*.sh' -print0 | xargs -0 -n1 bash -n

# Frontend
npm test --prefix frontend -- --watchAll=false && npm run build --prefix frontend

# ZK toolchain (circom is installed but NOT on PATH)
CIRCOM_BIN=$HOME/.local/circom/bin/circom bash scripts/local/check-toolchain.sh
```

Always run the relevant gate before claiming work is done — evidence before assertions.

## Working rules

- **This session is docs/setup-only** unless told otherwise: understand the code, fix docs,
  set up the environment. **Do not change application/contract/circuit code** yet.
- **Preserve the uncommitted WIP.** Never revert prior-agent dirty changes.
- **Do not push to `main`** or trigger any live deploy. GCP staging deploy and any ETL run
  **cost money and need explicit user approval**.
- Edit **docs only** where they are clean or clearly stale; for the deep-dirty docs see
  `docs/DOC_DEBT.md` and apply those fixes only after the WIP is committed.
- Never commit real secrets. Hardhat dev keys and the test-only RSA key in
  `crates/api/testdata` are the only keys that may be committed.
- For ZK artifact changes, verify `.sol`/`.wasm`/`.zkey`/verification-key all match the
  circuit version. For finalize/relay changes, test DB↔on-chain partial-failure behavior.

## Known doc debt

The top-level docs lag the code (the "Rust = scaffold" framing, stale audit verification
tables, `user_secret` column references, test-count mismatches, etc.). `docs/DOC_DEBT.md`
tracks all 41 known discrepancies with exact fixes. `README.md` and `AGENT.md` have been
corrected; the rest are pending the WIP commit.

## Recommended Claude Code setup

- **Security/audit work:** `solidity-auditor` agent + `blockchain-security` skill for the
  Solidity verifier, `VotingTally`, and the Circom circuit; `/security-review` on diffs.
- **Process:** `superpowers:brainstorming` before features, `superpowers:test-driven-development`
  (the repo is TDD-heavy — match it), `superpowers:systematic-debugging` for failures,
  `superpowers:writing-plans` for multi-step work.
- **Review:** `/code-review` (or `/code-review ultra` for the cloud multi-agent pass) before
  any merge; `/verify` and `/run` to exercise the app.
- **Korean docs:** the `humanize-korean` skills for polishing the Korean docs/runbooks.
- **Keep this file current:** `claude-md-management:revise-claude-md`.
