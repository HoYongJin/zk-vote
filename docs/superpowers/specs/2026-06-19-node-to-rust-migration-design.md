# Design — Complete Node → Rust Backend Migration

**Date:** 2026-06-19
**Branch:** `codex/phase1-c1-h1-circuit-contract-v2`
**Author:** dev+security lead (Claude, under user direction)
**Status:** approved-pending-user-review · **partially superseded 2026-06-20** — the frontend-auth
disposition below ("Supabase auth stays") is overridden by the GCIP auth migration in
`docs/PROJECT_PLAN.md` §0 / Phase 16. This spec covers only the Node *code* deletion; the frontend
Supabase→Firebase SDK swap happens in Phase 16, *after* these code-deletion commits.

## Goal

Retire the legacy Node/Express backend (`server/`) entirely and make the Rust
backend (`rust-backend/`) the single canonical API surface. Delete stale Node
assets; relocate (not delete) shared ZK assets; update CI, docs, and the
frontend dev pointer to match. This is a **code/codebase migration** — it does
**not** stand up GCP infra, run the ETL, or push to `main` (all cost-gated /
out of scope, see below).

## Why now / preconditions

- **Rust parity is verified, not assumed.** A read-only discovery pass mapped all
  16 Node routes to verified Rust equivalents (`parityGaps: []`), including the
  anonymous `submit` route (no auth extractor — invariant #1 intact) and the
  `proof` route (ticket binds `election_id`+`root` only — invariant #2 intact).
- **Working tree is clean** (verify `git status` is empty before Commit 1; the prior-agent WIP is committed), so
  the migration starts on a clean base and deep-dirty doc edits won't churn.
- System is **local-demo/dev-only** — nothing runs on real GCP/AWS, so removing
  the Node deploy path breaks no live system.

## Decisions (locked)

1. **ZK relocation target:** `server/zkp/` → top-level **`zk/`** (sibling of
   `contracts/`, `frontend/`, `rust-backend/`).
2. **Deletion completeness:** **vendor** the ETL/deploy helpers into `scripts/`,
   then **fully delete `server/`** in this pass (no thin stub left behind).
3. **Legacy deploy:** **delete `.github/workflows/deploy-backend.yml`**; Rust is the
   sole canonical backend. Frontend AWS CD (`deploy-frontend.yml`, `buildspec.yml`)
   is **untouched** — hosting is a separate open decision.

## The load-bearing trap (why naive `rm -rf server/` is forbidden)

`server/zkp/` is **not Node code**. It contains:
- `circuits/VoteCheck.circom` — canonical circuit, single source of truth (audit C1/H1)
- `powersOfTau28_hez_final_12.ptau` — phase-1 ceremony input
- `build_4_5/`, `build_5_4/` — the **EXACT** proving artifacts (zkey/vkey/wasm).
  Regenerating them produces fresh randomness and **invalidates every proof for
  every deployed election** (invariant #7, audit M5). Preserve the exact bytes.
- `setUpZk.sh` (builds circuit + exports `contracts/Groth16Verifier_*.sol`),
  `prove.sh` (dev CLI). `setUpZk.sh` resolves `circomlib`/`snarkjs` from
  `server/node_modules`, so deleting `server/package.json` without re-anchoring
  those breaks circuit recompilation.

**Therefore: relocation precedes deletion, and exact artifact bytes are preserved.**

## KEEP ledger (must survive — do not delete)

- `zk/` (relocated): `VoteCheck.circom`, ptau, `build_4_5`/`build_5_4` (exact bytes),
  `setUpZk.sh`, `prove.sh`.
- `scripts/migration/etl-supabase-to-postgres.js` — Phase-19 cutover ETL. **Hard
  constraint: never delete.**
- `contracts/*.sol` (VotingTally, Groth16Verifier_4_5/_5_4, test/MockVerifier),
  `artifacts/contracts/` + `artifacts/build-info/` (Rust runtime dep via
  `CONTRACT_ARTIFACTS_DIR`), `hardhat.config.js`.
- `scripts/deploy_verifier.js`, `deploy_votingtally.js`, `assertVerifierArity.js`.
- `test/VotingTally.js`, `voteCircuit.js`, `helpers/zkProof.js`, `poseidonCompat.js`,
  `etlChecksum.js` (contract/circuit/Poseidon/ETL tests — survive `server/` deletion).
- `.gcloudignore` / `.dockerignore` `.env`+`server/.env` excludes — keep even after
  `server/` removal (INFRA-1 control; `ci.yml` asserts `.env` present).
- `frontend/src/{api/axios.js,utils/apiBaseUrl.js,store/authSlice.js}` — backend-agnostic; keep.
  (`supabase.js` was originally KEEP here but is **superseded**: `PROJECT_PLAN.md` §0/Phase 16
  swaps the frontend to the Firebase/GCIP SDK *after* these code-deletion commits. This spec does
  not touch frontend auth.)
- Rust build/deploy infra (`rust-backend/Dockerfile`, `scripts/gcp/*`,
  `docker-compose.yml`, `scripts/local/*`) — cost-gated, do not auto-trigger.
- `audit.md` — point-in-time evidence; **annotate elsewhere, never rewrite**.

## Ordered plan (commit-sized units; each gated before the next)

**Commit 1 — Relocate the ZK toolchain (no Node-app deletions).**
- `git mv server/zkp zk`.
- Repoint in the same commit: `scripts/ci/check-artifact-schema.sh` glob (L12) +
  message (L23); `scripts/local/fetch-ptau.sh` `ZKP_DIR` (L16); `scripts/local/
  check-toolchain.sh` snarkjs/ptau paths (L36/L50); `scripts/deployAll.js`
  `setUpZk.sh` hint (L84); `ci.yml` shell-gate glob (`server/zkp` → `zk`); **and
  `.gcloudignore`** — repoint `server/zkp/{tmp,input,circomlib}/` → `zk/{tmp,input,circomlib}/`
  and drop `server/node_modules/` (keep the `.env`/`server/.env` excludes, INFRA-1).
- Copy exact `build_4_5`/`build_5_4` artifacts into `.data/zk-artifacts/` (currently
  empty) so the Rust local-serve path has content.
- Re-anchor `circomlib` for `setUpZk.sh`: add `circomlib` to **root** `package.json`
  (matching `server/package.json`'s pinned version). `setUpZk.sh` resolves circomlib
  + snarkjs via `${SCRIPT_DIR}/../node_modules/...`; with the script now at `zk/`,
  `zk/../node_modules` = root `node_modules`, so **no edit to `setUpZk.sh`'s path
  logic is required** — only the root dependency must exist. (Root already has snarkjs.)
- **Gate:** `bash scripts/ci/check-artifact-schema.sh` passes (it exit-1s on zero
  keys — the glob MUST move with the artifacts); `bash -n` on relocated `*.sh`;
  optional `CIRCOM_BIN=... bash zk/setUpZk.sh`-dry-run confirms circomlib resolves.

**Commit 2 — Vendor the ETL/deploy helpers off `server/`.**
- Copy `server/supabaseClient.js` + `server/utils/fieldElement.js` →
  `scripts/migration/`; `server/utils/zkArtifacts.js` → `scripts/`.
- Repoint `etl-supabase-to-postgres.js` (L23, L144), `deployAll.js` (L6, L7),
  `test/etlChecksum.js`, `test/zkArtifacts.js`, `test/fieldElement.js`,
  `scripts/deployEnv.js` (drop `server/.env` path) + `test/deployEnv.js`.
- **Gate:** `npx hardhat test --no-compile` green for ETL/artifact/deploy tests;
  no `server/` `require()` remains under `scripts/`.

**Commit 3 — Delete the Node app + its tests + CI lockstep (the big delete).**
- `git rm` `server/` entirely (entrypoint, package.json/lock, middleware, all
  routes incl. dead `secret.js`, all utils, `redisClient.js`, `supabaseClient.js`,
  `.env.example`, and the distinct `server/zk/merkle.json` scratch fixture —
  removed here, after a final no-refs confirm, since `server/zk/` was NOT relocated
  in Commit 1; only `server/zkp/` was). `electionId.js` confirmed bit-identical in
  Rust; `fieldElement.js`/`zkArtifacts.js`/`supabaseClient.js` already vendored.
- `git rm` the ~21 `test/*Route.js` + util/middleware tests + `routeTestUtils.js`.
- **Same commit** edit `ci.yml`: drop `npm ci --prefix server`, server cache path,
  both `npm audit --prefix server` lines; narrow JS gate `find server scripts test`
  → `find scripts test`; rename `contracts-and-node` job.
- **Gate (full CI mirror):** `npx hardhat test --no-compile`; JS+shell syntax gates;
  `cd rust-backend && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`; `npm test --prefix frontend -- --watchAll=false && npm run build --prefix frontend`.

**Commit 4 — Repoint frontend dev pointer + prune stray root deps.**
- `frontend/.env` `REACT_APP_API_BASE_URL` `http://localhost:3001/api` →
  Rust local addr (`http://localhost:8080/api`); update
  `frontend/src/utils/apiBaseUrl.test.js` port expectations.
- Delete dead `frontend/src/setupProxy.js` (hardcoded old AWS Node IP).
  (`server/zk/merkle.json` was already removed with the full `server/` deletion
  in Commit 3.)
- Prune `@reduxjs/toolkit`/`react-redux`/`react-router-dom` from root
  `package.json` (duplicated in frontend); regenerate `package-lock.json`. KEEP
  contract/ZK deps (hardhat, hardhat-toolbox, circomlibjs, fixed-merkle-tree,
  snarkjs, pg).
- **Gate:** `npm test --prefix frontend -- --watchAll=false && npm run build --prefix frontend`.

**Commit 5 — Reconcile docs to Rust-canonical.**
- Edit `README.md`, `AGENT.md`, `CLAUDE.md` (verify commands + narrative),
  `.env.example` (drop `server/.env` commentary); annotate
  `docs/API_COMPATIBILITY.md` Node column as "legacy reference / superseded";
  mark `docs/DOC_DEBT.md` items 29/31/35/36 resolved-by-deletion. Then deep-dirty
  docs (IMPLEMENTATION_GOALS, PROJECT_PLAN, ARCHITECTURE_REVIEW, RUNBOOK_SUPERSEDE)
  repointed to Rust/`zk/` paths. Leave `audit.md` untouched (historical).
- **Gate:** doc-only; no code/CI risk.

**Commit 6 — Retire the legacy AWS Node deploy.**
- Delete `.github/workflows/deploy-backend.yml`. Sequenced last.
- Out-of-band note (not a code change): the local `server/.env` Supabase
  service-role + relayer keys should be rotated/decommissioned as Node teardown.

## Out of scope (explicitly NOT done here)

- **Supabase *data*-layer decommissioning** — this is a Node→Rust *code* migration;
  Supabase→Postgres data cutover is Phase-19 (ETL, cost-gated, user-approved).
  Frontend auth (Supabase→Firebase/GCIP) is **out of scope for this spec but IN scope for the
  project** — it is done in `PROJECT_PLAN.md` Phase 16, after these commits (this supersedes the
  earlier "frontend keeps Supabase auth" wording). `deployAll.js` keeps its (now vendored) Supabase
  metadata write until the Phase-20 ETL / Supabase decommissioning retires it.
- **GCP staging deploy (Phase 16)** and **ETL run (Phase 19)** — cost money, need
  explicit approval; not triggered.
- **Frontend hosting decision** (AWS vs GCP) — open; `deploy-frontend.yml`/
  `buildspec.yml` left as-is.
- **No push to `main`**; no auto-trigger of any GCP/AWS deploy.

## Top risks & mitigations

| Risk | Mitigation |
|---|---|
| `rm -rf server/` destroys shared ZK assets | Relocation (Commit 1) precedes any deletion |
| Regenerating zkeys invalidates all proofs (inv. #7) | Move exact bytes; never "rebuild fresh" |
| Deleting ETL deps breaks Phase-19 cutover | Vendor first (Commit 2) before delete (Commit 3) |
| `server/` removal breaks CI 4 ways | `ci.yml` edited in the same commit (Commit 3) |
| `check-artifact-schema.sh` exit-1s on moved glob | Repoint glob in lockstep (Commit 1) |
| `setUpZk.sh` loses circomlib/snarkjs | Re-anchor at `zk/` before deleting `server/` deps |
| `deploy-backend.yml` can pull frozen `main` | Delete it (Commit 6); never dispatch meanwhile |

## Verification philosophy

Evidence before assertions. Each commit runs its CI-mirror gate locally and is
only made once green. No commit is claimed "done" without the gate output.
