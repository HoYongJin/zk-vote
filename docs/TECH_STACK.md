# zk-vote — Technology Stack & Decision Record

This document fixes the technology choices for zk-vote and records **why** each was made,
so future contributors don't re-litigate settled decisions and can see which decisions are
still **OPEN**. It reflects the state of branch `codex/phase1-c1-h1-circuit-contract-v2`.

Status legend: **LOCKED** (decided, in use) · **OPEN** (decision still required).

---

## 1. Backend — Rust (replacing Node/Express)  · LOCKED

| Choice | Version | Why |
|---|---|---|
| **Rust** | edition 2021, toolchain 1.96 | The backend is a crypto + relayer service whose correctness around state machines (deploy → finalize → vote → complete) and DB↔chain partial failures is safety-critical. Rust's type system and exhaustive matching turn many of the legacy Node runtime bugs (audit H3/H4/M-series) into compile errors. Memory safety matters for a service that handles signing keys. |
| **axum** | 0.7 | Tower-based, async-first HTTP framework with first-class extractors — used for the typed `AdminUser`/`CurrentUser` auth extractors and clean per-route handlers. Integrates with the tower-http middleware stack already in use. |
| **tokio** | 1.x | De-facto async runtime; `signal` feature drives graceful shutdown (drain in-flight requests on Cloud Run SIGTERM). |
| **sqlx** | 0.8, `postgres` + **rustls** + `uuid` + `time` + `json` + `macros` | **Compile-time-checked SQL** against the real schema — the durable DB is the "last line of defense," so query/type drift must fail the build, not production. `rustls` avoids OpenSSL in the container image. |
| **redis** | 0.27, `tokio-comp` | Single-use submission tickets (TTL), registration/finalize locks, relay serialization. Async client matching tokio. |
| **alloy** | 1.x, `full` | Modern, typed Ethereum library (successor to ethers-rs). Typed `VotingTally`/verifier bindings; deploys the verifier + tally and relays `configureElection`/`submitTally`. Replaces the legacy `ethers.js` v5 surface. |
| **jsonwebtoken** | 9 | Validates IdP-issued JWTs against the IdP JWKS (RS256), checking issuer + audience. The verifier is **provider-agnostic / config-swappable**: auth migrates **Supabase Auth → GCP Identity Platform (GCIP)** (`securetoken` JWKS / `https://securetoken.google.com/<project>` issuer / `<project>` audience), so the backend stays a pure JWT verifier and the swap is an env change, not a code change (PROJECT_PLAN §0). |
| **light-poseidon** + **ark-bn254** + **ark-ff** | 0.2 / 0.4 / 0.4 | Poseidon over the BN254 scalar field, parameterized to be **bit-identical** to the Circom circuit and circomlibjs (audit AR-H7). The Rust backend computes Merkle roots that must match client-generated proofs exactly. |
| **utoipa** | 5 | `ToSchema` derives for API types. NOTE: schema derives exist but **no OpenAPI document is served yet** — treat as a TODO, not a shipped feature. |
| **tower / tower-http** | 0.5 / 0.6 (`cors`, `trace`, `request-id`) | CORS, request-id propagation, and tracing middleware. |
| **tracing** + **tracing-subscriber** | 0.1 / 0.3 (`env-filter`) | Structured logs with request-id correlation. |
| **reqwest** | 0.12, **rustls-tls**, `json` | Fetches JWKS and (in `gcs` mode) streams artifacts using a GCS metadata access token. |
| **thiserror** | 1 | Typed error enums mapped to stable API error codes. |

**Single binary:** only `zkvote-api` is built. `crates/workers` is a placeholder (a lone
`WorkerError` enum); finalize/deploy run **inline** in request handlers under Redis leases +
pg advisory locks. If a true background worker is ever needed, this is where it goes.

---

## 2. Data layer  · LOCKED

| Choice | Why |
|---|---|
| **PostgreSQL** (Cloud SQL target; Supabase Postgres legacy) | ACID source of truth and last line of defense. Unique constraints (`unique(election_id, nullifier_hash)` etc.), `CHECK`-enforced BN254 field-element domain (audit M8), and explicit lifecycle `state` enum. `pgcrypto` (uuid PKs) + `citext` (case-insensitive emails). |
| **snake_case-only schema** (audit M6) | Drops the legacy Supabase/PostgREST PascalCase compatibility layer. Migration `0002` is the retained-but-superseded compat shim; `0001` already creates the modern shape (see `docs/DATA_MODEL.md`). |
| **Two-role privilege model** (audit AR-M3, `db/roles.sql`) | `zkvote_migrator` owns DDL; `zkvote_app` is **DML-only** (and the migrator URL is deliberately **not** mounted on the API service). `zk_artifacts` / `contract_deployments` are **append-only** (SELECT/INSERT). Applied by `scripts/local/db-roles.sh`, **not** by a migration. |
| **Redis** (Memorystore basic target) | Ephemeral by design: 5-minute single-use submit tickets, locks, relay queue. Non-persistent — no durable state may depend on it. |

---

## 3. Smart contracts & ZK  · LOCKED (v1)

| Choice | Version | Why |
|---|---|---|
| **Solidity** | 0.8.20 | Built-in overflow checks; `VotingTally` + generated Groth16 verifiers. |
| **Hardhat** + hardhat-toolbox | 2.24 / 5 | Established JS test/deploy toolchain (`test/VotingTally.js`, `scripts/deploy*.js`). **Hardhat Ignition is NOT used** — the empty `ignition/` tree is vestigial; deploys go through plain `hre.ethers` scripts. |
| **Circom** | 2.2.3 (source-built at `~/.local/circom/bin`, **not on PATH** — use `CIRCOM_BIN`) | Circuit language for `VoteCheck.circom`. |
| **snarkjs** | 0.7.5 (exact pin, server + frontend) | Groth16 setup, witness, proving, verification-key/`.sol` verifier generation. Always the local `node_modules/.bin/snarkjs`. |
| **Groth16 over BN254** | — | Constant-size proof + cheap, constant-gas on-chain pairing verification — the right trade-off for per-vote on-chain verification. `nPublic = 4`: `[root_out, vote_index, nullifier_hash, election_id]` (snarkjs orders outputs before declared public inputs, so `election_id` is index 3). |
| **Verifier variants** | `Groth16Verifier_<merkleDepth>_<numCandidates>` | Per `(depth, candidates)` shape, e.g. `_4_5` = depth 4 / 5 candidates. Build dirs `build_<depth>_<candidates>`. (Several committed `_*.sol` files are pre-C1 `uint[3]` and **stale** — see `docs/DOC_DEBT.md`.) |
| **Noir** | POC-only | Explicitly out of the v1 production path; nothing in the production artifact selection may depend on `nargo`. |
| **ptau** | `powersOfTau28_hez_final_{12,16,20}` | Provisioned per environment with blake2b checksum verification (`scripts/local/fetch-ptau.sh`); gitignored. Only `_12` (depth ≤ 5) is present locally. |

---

## 4. Frontend — React (existing)  · LOCKED stack, OPEN hosting

| Choice | Version | Why |
|---|---|---|
| **React** | 19.2 | Existing SPA. |
| **Create React App** (react-scripts) | 5.0.1 | Existing build tooling. (Long-term, a Vite/Next migration is a candidate but **out of scope** for the backend migration.) |
| **Redux Toolkit** + react-redux | 2.9 / 9.2 | Auth/session state. |
| **axios** | 1.12 | API client; base URL is feature-flagged (`apiBaseUrl.js`) to switch Node→Rust. |
| **firebase** (Firebase Auth Web SDK) | 12 | GCP Identity Platform (GCIP) login/session — email/password (+ e-mail verification, password reset) and Google OAuth (replaces Supabase Auth + Kakao, Phase 16). Role lookups go through the backend `/api/me` (audit AR-H4), not direct table reads. The web `apiKey` is public client config, not a secret. |
| **poseidon-lite** | 0.3.0 | Browser Poseidon for the client-held secret + leaf commitment. Chosen over circomlibjs because **circomlibjs cannot be bundled under CRA/webpack 5**. Must stay bit-identical to the circuit. |
| **snarkjs** (browser) + web worker | 0.7.5 | Browser-side Groth16 proof generation in `proof.worker.js`, so the **secret never leaves the client** (audit H2). |

---

## 5. Infrastructure & CI/CD  · LOCKED backend, OPEN frontend

| Choice | Why |
|---|---|
| **GCP Cloud Run** | Stateless, scale-to-zero container hosting for `zkvote-api`; graceful SIGTERM drain. Built from `rust-backend/Dockerfile` via Cloud Build. Deployed `--allow-unauthenticated` (auth enforced in-app via IdP JWT verification — GCIP target, Supabase pre-cutover). |
| **Cloud SQL (Postgres)** + **Memorystore (Redis)** | Managed Postgres/Redis reached over a **VPC connector**. |
| **Secret Manager** | Per-secret IAM (audit M9), `zkvote-staging-*` prefix. The owner key (`zkvote-staging-owner-private-key`) is mounted and **must differ** from the relayer key. |
| **Artifact Registry / GCS** | Container images + ZK artifacts (served via SA metadata token in `gcs` mode, audit AR-M6). |
| **GitHub Actions** | CI gates: Hardhat + Node route tests, frontend build/test, Rust `fmt`/`clippy -D warnings`/`test`, migration apply-twice idempotency + no-legacy-columns + runtime-role privilege gate, and dependency audits (`npm audit` + `cargo audit`, audit AR-H8). Live AWS deploy is `workflow_dispatch`-gated (audit M11). |

---

## 6. OPEN decisions (need an owner)

1. **Frontend hosting after cutover — RESOLVED (2026-06-20): GCP / Firebase Hosting**
   (PROJECT_PLAN §0.4). The frontend moves to Firebase Hosting (same project as GCIP),
   retiring the AWS S3/CloudFront CD (`deploy-frontend.yml`, `frontend/buildspec.yml` —
   kept `workflow_dispatch`-only until the Firebase Hosting CD lands in Phase 18). The
   chosen origin gates `deploy-staging-api.sh`'s `CORS_ALLOWED_ORIGINS`.
2. **AR-M1 — cryptographic unlinkable authorization.** Today the operator de-anonymization
   ceiling is the submission ticket, mitigated only by a non-logging principle. Whether to
   adopt blind-signed / anonymous-credential tokens is **deferred to a Phase-18 decision**
   after staging timing measurement.
3. **Rust toolchain pinning.** CI builds with floating `dtolnay/rust-toolchain@stable` while
   the container pins `rust:1.96`. Recommend adding `rust-backend/rust-toolchain.toml`
   (channel 1.96) so CI and the shipped image use the same compiler.
4. **Reverse ETL for rollback.** The cutover runbook references an inverse ETL that does not
   exist (only the forward Supabase→Postgres script is committed). Decide: commit a reverse
   script or mark the rollback step as a manual procedure.

---

## 7. What is explicitly NOT in the stack

- **No Hardhat Ignition** (plain deploy scripts only).
- **No ORM** on the Rust side beyond sqlx's query macros (raw, compile-checked SQL).
- **No background worker process** (inline handlers; `crates/workers` is a stub).
- **No OpenSSL** anywhere in the Rust path (rustls throughout).
- **No Noir** in production.
- **No IP rate-limiting** on `/submit` — it is gated by ticket issuance, not by IP
  (the `express-rate-limit` dep in the Node server is declared but unused).
