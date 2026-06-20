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

The project is **mid-migration**: the legacy **Node/Express** backend (`server/`) has
been **deleted (Phase 6.5)** and replaced by the **Rust** backend (`rust-backend/`).
The remaining migration is the cloud rollout — Supabase Auth→GCIP, Supabase
Postgres→Cloud SQL, and GCP staging/cutover (see `docs/PROJECT_PLAN.md`).

## Current status — read this before assuming anything

- The Rust backend is the **sole backend** (not a scaffold). It has **full route parity**
  with the old Node API (16 routes incl. anonymous `submit`, `proof`, `finalize`,
  `setZkDeploy`, artifacts, admin/voter lists) plus a large Phase 5–13 integration-test
  suite, verified green locally (db repos 6/6; the real-proof vote-pipeline E2E).
- The **legacy Node `server/` was deleted (Phase 6.5)** and the ZK toolchain relocated to
  top-level `zk/`. Implementation + hardening (Phases 0–15, 17, and 6.5) are done on this
  branch. What remains is the **cloud rollout**: GCIP auth standup + user import (Phase 7),
  the frontend Supabase→Firebase SDK swap (Phase 16), GCP staging infra (Phase 18), the
  Supabase→Cloud SQL ETL (Phase 20), and cutover/production (Phases 21–22). Nothing runs on
  real GCP infra yet; the system is local-demo/dev-only.
- **`main` is now the working branch** (de-frozen 2026-06-21; the misnamed
  `codex/phase1-c1-h1-circuit-contract-v2` was fast-forwarded into it). The old "main is
  frozen" rule is **lifted** — its rationale (a push to `main` triggering the legacy AWS
  auto-deploy, audit M11) is resolved: `deploy-backend.yml` is deleted, `deploy-frontend.yml`
  is `workflow_dispatch`-only, and `ci.yml` now runs on `main` pushes. `origin/main` is NOT
  yet pushed — push is a separate explicit step (now safe; no auto-deploy fires).
- The cost-gated cloud steps (GCIP enable, user import, GCP standup, ETL, deploy) need
  explicit user approval (`CONFIRM_COSTS=yes`). Never commit real secrets.

## Architecture

```
Current (local): React → Rust API (axum) → Postgres + Redis + Circom/snarkjs (zk/) → Solidity VotingTally + Groth16Verifier
                 (frontend now on the Firebase/GCIP SDK — Phase 16 done; the Rust backend still validates Supabase-issued JWTs until the Phase-18 GCIP secret repoint)
Target:          React (Firebase/GCIP) → Rust API (axum) → Cloud SQL(Postgres) + Memorystore(Redis) + GCS artifacts + alloy relayer → VotingTally + Groth16Verifier
```

Rust workspace crates: `api` (axum routes), `domain` (services + state machine),
`db` (sqlx repos), `chain` (alloy), `zkp` (bit-exact Poseidon/Merkle), `workers`
(**placeholder stub only** — finalize/deploy run inline in request handlers, guarded
by Redis leases + pg advisory locks; `finalization_jobs` is an audit/retry trail, not a
consumed queue).

## Tech stack (summary — full rationale in `docs/TECH_STACK.md`)

- **Backend:** Rust — axum 0.7, tokio 1, sqlx 0.8 (postgres, **rustls**, compile-checked),
  redis 0.27, alloy 1, jsonwebtoken 9 (JWKS verifier — GCIP target, config-swappable), light-poseidon 0.2 + ark-bn254 0.4,
  utoipa 5, tower-http 0.6, reqwest 0.12 (rustls).
- **Contracts:** Solidity 0.8.20, Hardhat 2.24 + hardhat-toolbox 5 (no Ignition).
- **ZK:** Circom 2.2.3 + snarkjs 0.7.5, Groth16 over BN254. `nPublic = 4`:
  `[root_out, vote_index, nullifier_hash, election_id]`.
- **Frontend:** React 19, Create React App (react-scripts 5), Redux Toolkit 2.9,
  axios 1.12, firebase 12 (Firebase Auth Web SDK / GCIP), poseidon-lite 0.3.0 + snarkjs (browser proving).
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
8. **Admin promotion & voter eligibility trust the JWT `email` claim.** Under **GCP
   Identity Platform (GCIP)** — the IdP that replaces Supabase Auth — there is **no
   provider-level "require verified e-mail before sign-in" toggle** for basic
   email/password, so the invariant is carried **app-side**: the backend reads the
   **top-level `email_verified`** claim and RUST-AUTH-2 **refuses an explicitly
   unverified e-mail**, so it cannot consume a pending admin invitation or a voter slot
   for someone else's inbox. Supporting controls: GCIP does not autoconfirm password
   sign-ups (the verify-email flow is real) and Google-asserted e-mails arrive
   `email_verified=true`. (Pre-migration this was primarily the Supabase "confirm email"
   deployment setting; post-migration the **app-layer check is the primary control**.)

**Deployment & security findings:** the 2026-06-19 adversarial audit and its remediation
are tracked in `docs/SECURITY_AUDIT_2026-06.md` (read it before deploy; it lists the
accepted/deferred items and their rationale).

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
find scripts test -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
find scripts zk -name '*.sh' -print0 | xargs -0 -n1 bash -n

# Frontend
npm test --prefix frontend -- --watchAll=false && npm run build --prefix frontend

# ZK toolchain (circom is installed but NOT on PATH)
CIRCOM_BIN=$HOME/.local/circom/bin/circom bash scripts/local/check-toolchain.sh
```

Always run the relevant gate before claiming work is done — evidence before assertions.

## Working rules

- **Implementation is active.** The no-cost migration phases (6.5 Node deletion, 7 GCIP
  prep, 16 frontend Firebase swap, 17 CI, 18 deploy-script prep, 19 docs) are DONE and
  green; the remaining work is the **cost-gated cloud rollout** (18 execute / 20 / 21 / 22).
- **Commit working changes** behind their CI-mirror gate (the prior uncommitted WIP is now
  committed). Run the relevant gate before claiming done — evidence before assertions.
- **`main` is the working branch** — pushing it is safe (no auto-deploy fires). But any
  cost-incurring action (GCP standup, GCIP enable/import, Cloud SQL ETL, Cloud Run deploy)
  still needs **`CONFIRM_COSTS=yes` + explicit user approval**.
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
