# zk-vote End-to-End Project Plan

> **Revision 2026-06-20.** This revision integrates three migration workstreams into one
> phased plan: **(A)** complete Node→Rust backend cutover (the legacy `server/` is deleted,
> Rust is the sole API), **(B)** Supabase Postgres → Cloud SQL Postgres data ETL, and
> **(C)** Supabase Auth (GoTrue) → **GCP Identity Platform (GCIP)** identity migration.
> It **supersedes** the prior "keep Supabase Auth" direction (old `PROJECT_PLAN.md` §2 /
> `docs/TECH_STACK.md` §auth). See §0 Decision Record. The complete-Node-deletion code steps
> are specified separately in `docs/superpowers/specs/2026-06-19-node-to-rust-migration-design.md`
> and referenced here as the codebase precondition for the cutover.

## 0. Auth & Cloud Migration Decision Record (2026-06-20)

### 0.1 Decision

Migrate the identity provider from **Supabase Auth → GCP Identity Platform (GCIP)** — the
email/password provider, with **email verification enforced**. The Rust JWKS verifier is
**reused unchanged** and repointed by environment to Google's `securetoken` JWKS. Admin and
voter authority stay **DB-derived from the verified `email` claim** (no GCIP custom-claim
authorization in v1).

| Setting | Supabase (old) | GCIP (new) |
|---|---|---|
| Issuer (`iss`) | `{SUPABASE_URL}/auth/v1` | `https://securetoken.google.com/<PROJECT_ID>` |
| Audience (`aud`) | `authenticated` | `<PROJECT_ID>` (bare project id) |
| JWKS URL | `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` | `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` |
| `email_verified` | `user_metadata.email_verified` (fallback) | **top-level** boolean (already read by `token.rs`) |
| Password hash | bcrypt `$2a/$2b` | imported verbatim via `importUsers algorithm:'BCRYPT'` |
| Signing alg | RS256 | RS256 (verifier already supports it) |

> ⚠️ **Do NOT** point the JWKS URL at the `/robot/v1/metadata/x509/` endpoint — it returns PEM
> certs the `KeySet` parser rejects. Use the `/service_accounts/v1/jwk/` (JWK `n`/`e`) URL only.

### 0.2 Rationale (why GCIP over the alternatives)

GCIP is the lowest-risk swap that keeps the entire existing trust model intact: the Rust
verifier already does RS256 via `DecodingKey::from_rsa_components`; invariant #8 is preserved
natively because GCIP surfaces a **top-level `email_verified`** and does **not** autoconfirm
password sign-ups; bcrypt hashes migrate verbatim (no voter reset); pricing is effectively
zero (**50,000 MAU free** for email/password — re-verify on the official pricing page before any
budget statement); and it stays inside the already-scripted GCP project and Secret Manager
cost-gate. The only unavoidable new surface is the frontend SDK rewrite (Supabase JS → Firebase
Auth Web SDK).

| Alternative | Pro | Con (why not v1) |
|---|---|---|
| **Keep Supabase Auth**, move only data to Cloud SQL | Zero auth/frontend change; `sub` UUIDs unchanged | Leaves a Supabase vendor + billing surface in the critical path; contradicts the full-GCP goal |
| **Keycloak on Cloud Run** | No per-MAU cost, full claim control, OIDC JWKS drop-in | You operate a stateful IdP (own Postgres, poor scale-to-zero fit, patching); manual password import |
| **Ory Kratos/Hydra** or **backend-as-IdP** | Cloud-native OSS / zero external dep | Kratos is headless (build all login/verify/reset UI); backend-as-IdP re-introduces password/verify/reset/key-rotation security surface + a fresh audit |

### 0.3 Identity-keying resolution (the load-bearing fact)

Identity is **MIXED, email-dominant**. The `email` claim is the primary authorization join key
(admin promotion via `admin_invitations.email`; voter eligibility via the `voters.email`
allowlist — invariant #8). **But** the Supabase user UUID (`sub`) is *also* persisted and
load-bearing: it is `admins.id` (PK) and `voters.user_id`, the join key for post-registration
voter views (`list_voting_for_user` / `list_completed_for_user`) and the AR-H6 re-bind
ownership check. The Rust extractor parses `sub` via `Uuid::parse_str`
(`crates/api/src/auth/mod.rs:90-92`).

GCIP's native uid is a 28-char string, **not** a UUID — an unmodified GCIP token would `401`
on every request *and* match no DB row. **Resolution adopted:** at `importUsers` time set each
migrated user's **GCIP uid = their existing Supabase UUID string**. This keeps `sub` a UUID,
leaves `CurrentUser.id: Uuid`, `admins.id`, `voters.user_id`, the `(election_id, user_id)`
UNIQUE constraint, and the `user_secret_commitment` binding **all unchanged** — no schema
change, no DB remap, no voter re-registration. Any user created post-import via normal GCIP
sign-up gets a non-UUID uid and would `401`; therefore **all identities must be provisioned
with UUID uids** (import or scripted), or the invasive fallback (change `CurrentUser.id` to
`String` + migrate `admins.id`/`voters.user_id` column types + a remap table) is required.

### 0.4 Scope sign-off & invariants

- The IdP swap **overrides** the documented "keep Supabase Auth" decision; `docs/TECH_STACK.md`
  and `CLAUDE.md` invariant #8 wording (`Supabase email-confirmation` → `IdP email-verification`)
  are a documentation follow-up tracked in Phase 0/19.
- **Process invariants (unchanged):** `main` stays frozen (no live-deploy push); enabling GCIP,
  the user import, the GCP infra standup, and the Cloud SQL ETL are all **cost-gated**
  (`CONFIRM_COSTS=yes`) and require **explicit user approval**; legacy AWS workflows stay
  `workflow_dispatch`-gated; never commit real secrets (Firebase Admin SA JSON + Supabase creds
  are gitignored).

---

## 1. Goal

Build zk-vote as a production-oriented zero-knowledge voting system with this **GCP-native**
target architecture:

```text
React frontend (Firebase Auth Web SDK / GCIP login)
  -> Rust API backend (axum, sole backend; legacy Node deleted)
    -> Cloud SQL PostgreSQL (zkvote_app DML role; zkvote_migrator DDL role)
    -> Memorystore Redis (locks, short-lived proof tickets)
    -> GCS ZK artifact storage
    -> Ethereum relayer (hot key) / owner key (cold)
      -> VotingTally + Groth16 verifier contracts
  Identity: GCP Identity Platform (email/password, email-verification enforced)
            JWT validated in Rust by JWKS/issuer/audience (config-swap from Supabase)
```

The migration must preserve the existing public API behavior and the privacy/integrity model
while retiring every Supabase and Node dependency from the runtime path.

## 2. Current Baseline (as of 2026-06-20)

**Implementation + hardening are done; the remaining work is the cloud rollout + the auth/IdP
migration.** On branch `codex/phase1-c1-h1-circuit-contract-v2`:

- **Rust backend has full 16-route parity** with Node (anonymous `submit`, `proof`, `finalize`,
  `setZkDeploy`, artifacts, admin/voter lists) + a Phase 5–13 integration-test suite.
- **A full adversarial security audit ran (2026-06-19) and 14 fixes landed**, all gates green
  (`docs/SECURITY_AUDIT_2026-06.md`). The Rust `FixedMerkleTree` is verified **bit-exact** with
  the circuit/JS root.
- Local Postgres + Redis via Docker Compose; GCP staging bootstrap script
  (`scripts/gcp/zkvote-staging-setup.sh`) for Cloud SQL, Memorystore, GCS, Secret Manager, VPC
  connector, service account.
- ZK toolchain (Circom/snarkjs), `VotingTally` + Groth16 verifier (`uint256[4]`,
  `nPublic = 4`), beacon-finalization design.

**Not yet executed (the forward work this plan covers):**

1. **Node→Rust code deletion** — relocate `server/zkp` → `zk/`, vendor ETL deps, delete `server/`
   (spec: `docs/superpowers/specs/2026-06-19-node-to-rust-migration-design.md`).
2. **GCP Identity Platform standup + Supabase→GCIP user migration** (NEW — this revision).
3. **Frontend auth SDK swap** (Supabase JS → Firebase Auth Web SDK) (NEW).
4. **GCP staging infra standup + Secret Manager repoint to GCIP** (Phase 16-original, never run).
5. **Cloud SQL ETL** (`scripts/migration/etl-supabase-to-postgres.js`, never run).
6. **Cutover + production**.

Nothing runs on real GCP/AWS infra yet — the system is local-demo/dev-only.

### Known direction (revised)

- Production ZK path: Circom/Groth16. Noir: separate POC only.
- **Auth: migrate Supabase Auth → GCP Identity Platform; validate JWT/JWKS in Rust** (§0).
- **Database: Cloud SQL PostgreSQL** (data moved from Supabase via Phase-20 ETL).
- Cache/lock/tickets: Memorystore Redis.
- Chain: Solidity + Ethereum-compatible relayer (owner key ≠ relayer key).
- **Backend: Rust only** — the legacy Node `server/` is deleted, not kept as a reference copy.
- Plan ordering is security-first and dependency-ordered; each phase has a verification gate.

## 3. Project Principles

- Preserve the public API contract and the privacy/integrity invariants across all three
  workstreams; the frontend UX must not change for voters/admins.
- **The IdP is a configuration swap, not an authorization rewrite:** authority stays DB-derived
  from the verified `email` claim, never from a token role/custom claim.
- Keep submit anonymous. Do not require JWT on final vote submission (invariant #1).
- Make election lifecycle explicit via the state machine; store durable state in Postgres; use
  Redis only for locks, short-lived proof tickets, and runtime coordination.
- Every phase has a concrete verification gate before the next phase depends on it.
- No GCP/AWS cost-incurring action (GCIP enable, user import, infra standup, ETL, deploy) runs
  without `CONFIRM_COSTS=yes` + explicit user approval; `main` stays frozen.
- Treat audit findings as planning inputs; no staging/production claim while any Critical/High
  in `audit.md` / `docs/SECURITY_AUDIT_2026-06.md` is open.

## 4. Target E2E Product Flow

This flow is the post-migration target (GCIP auth, Rust backend, Cloud SQL).

### Admin Flow

1. Admin signs in through **GCP Identity Platform** (email/password; email must be verified).
2. Admin creates an election draft.
3. Backend validates dates, candidates, Merkle depth, and initial state.
4. ZK artifacts are selected/generated for `(depth, candidate_count)`.
5. Verifier and `VotingTally` are deployed/linked from an artifact manifest whose hashes match
   the stored election artifact version.
6. Admin opens registration and allowlists voters **by email**.
7. Eligible voters register with a client-held secret, binding only a secret commitment/leaf.
8. Admin finalizes after the deadline / explicit fail-closed transition.
9. Backend snapshots voters, computes the Merkle root, configures the contract, marks voting active.
10. After voting ends, admin completes the election; backend reads/aggregates the final tally.

### Voter Flow

1. Voter signs in through **GCP Identity Platform**.
2. Frontend lists registerable elections (keyed on the verified email).
3. Voter registers (binds `voters.user_id = token sub`, a UUID).
4. Frontend lists active finalized elections.
5. Voter requests a Merkle proof + one-time submit ticket (ticket binds `(election_id, root)`
   ONLY — never the nullifier, AR-H5).
6. Frontend generates the ZK proof locally from the client-held secret.
7. Voter submits proof, public signals, candidate index, and ticket — **no Authorization header**.
8. Backend validates ticket binding, proof/signal shapes, candidate range, root, nullifier
   uniqueness, and contract preflight, then relays the vote.
9. Results surface only through the completed-election view.

> Accepted v1 property (AR-L3): on-chain data is public — running tallies and per-vote choices
> are readable during voting, and a secret-holder can prove how they voted. Hiding these needs a
> commit-reveal / aggregated-tally redesign, out of scope for v1.

## 5. Phase Plan

> **Status legend:** ✅ Done · 🟡 Partial (done for the old stack; has a delta for this revision) ·
> 🆕 New / not started. Phases are dependency-ordered; numbers in **dependsOn** reference phases here.

### Phase 0. Project Governance and Scope Lock — ✅ (record updated this revision)

**Objective:** Lock v1 scope to the three integrated workstreams and record the IdP decision.

**Tasks:**
- Keep `AGENT.md` as the repo map and this file as the execution plan; record that it supersedes
  the prior "keep Supabase Auth" direction (§0).
- Refresh `docs/API_COMPATIBILITY.md` (every legacy Node route → Rust handler, auth mode, body,
  response, error notes); annotate the Node column as legacy/superseded once `server/` is deleted.
- Record the GCIP decision, rationale, alternatives, and identity-keying resolution (§0).
- Name environments (local / staging / production); confirm cost-gates and `main`-freeze.

**Verification gate:** every legacy route appears in the compatibility matrix; the IdP-swap
decision and its override of the old plan / `TECH_STACK.md` are written down with sign-off.

**Deltas for this revision:** update `docs/TECH_STACK.md` §auth and `CLAUDE.md` invariant #8
wording (`Supabase email-confirmation` → `GCIP email-verification`) — tracked, applied in Phase 19.

### Phase 1. Audit Blocker Rebaseline — ✅

**Objective:** Close all Critical/High audit blockers before any staging/cutover work. **Hard
gate:** no staging deploy (Phase 18) or cutover (Phase 21) proceeds with an open Critical/High.

**Tasks (done):** circuit/contract v2 (C1 public `election_id`; H1 boolean `pathIndices`;
regenerated wasm/zkey/vkey/Solidity verifier; `VotingTally`/`IVerifier` at `nPublic=4`); H2
client-held secret (backend stores only the Poseidon commitment; `/proof` never returns
plaintext); H3/H4 durable deployment/finalizing state + lock fencing + artifact-hash binding +
snapshot revalidation; H5 invitation acceptance / auth-time promotion (keyed on verified email);
M1/M12 atomic ticket consume; M2/M4/M5 ptau checksums, circom, candidate limits/dedup,
artifact-version binding; M9/M10/M11 secret-scoped IAM, DB-URL secret ordering, AWS CD gating;
M13/AR-L10 registration-lock timeout + fencing.

**Verification gate:** no open Critical/High in `audit.md` / `docs/SECURITY_AUDIT_2026-06.md`;
`cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test
--workspace` green; `npx hardhat test --no-compile` green incl. dup-nullifier / wrong-election /
wrong-root / candidate-overflow cases. **dependsOn:** [0].

### Phase 2. Local Development Foundation — ✅

**Objective:** Reproducible local dev for Rust + contracts + ZK toolchain.

**Tasks:** Docker Compose Postgres 16 + Redis 7; `.env.example` aligned; `scripts/local/{smoke,
migrate}.sh`; circom checks + `.ptau` provisioning; `snarkjs` via `node_modules/.bin`/`npx`
(no global); Noir POC isolated from production v1.

**Verification gate:** `bash scripts/local/smoke.sh && bash scripts/local/migrate.sh` succeed;
Rust fmt/test/clippy pass; `CIRCOM_BIN=$HOME/.local/circom/bin/circom bash
scripts/local/check-toolchain.sh` passes. **dependsOn:** [1].

> **Delta (Node-deletion):** after the `server/zkp` → `zk/` relocation (migration spec Commit 1),
> repoint `scripts/local/fetch-ptau.sh` and `check-toolchain.sh` at `zk/`, and add `circomlib`
> to the **root** `package.json` so `setUpZk.sh` resolves it from root `node_modules` (the
> script's `${SCRIPT_DIR}/../node_modules` path resolves to repo root once it lives at `zk/`).

### Phase 3. Data Model and Migration Hardening — ✅

**Objective:** Make Cloud SQL Postgres the durable source of truth with the two-role privilege
model; settle the schema decisions the ETL depends on.

**Tasks:** review `0001_initial.sql` + `0002_node_api_compatibility.sql` vs Node usage (M6
PascalCase vs snake_case), `updated_at` handling, indexes, canonical state transitions; decide
table-case mapping, `elections.circuit_id` default/nullability (M7), field-element storage
`text` + CHECK vs `numeric(78,0)` (M8); implement the two-role model (AR-M3, no RLS):
`zkvote_migrator` (DDL) vs `zkvote_app` (DML-only).

**Migration inventory (all four apply to Cloud SQL via the migrator role):** `0001_initial.sql`,
`0002_node_api_compatibility.sql`, `0003_phase3_hardening.sql`, `0004_supersede_and_deployments.sql`
— append-only; the Phase-20 ETL targets the schema they produce. ⚠️ `0002_node_api_compatibility.sql`
is **misnamed**: it carries **core DDL** the Rust backend depends on (`admins`, `admin_invitations`,
the `citext` extension, election-window indexes), **not** disposable Node shims — it **must survive
the Node deletion (Phase 6.5)** and must never be dropped.

**Verification gate:** `bash scripts/local/db-verify.sh` passes; `zkvote_app` cannot run DDL;
duplicate voter email / `user_id` / nullifier per election rejected; BigInt field elements
round-trip byte-identically. **dependsOn:** [2].

> **Auth-migration constraint:** `admins.id` and `voters.user_id` **must stay UUID-typed** — the
> GCIP `uid = Supabase-UUID` import (Phase 7) depends on this. No column-type change in v1.

### Phase 4. Rust Backend Core — ✅

**Objective:** Common Rust API foundation. **Tasks:** modularize `main.rs` (config/error/state/
routes/middleware); typed errors + JSON responses; request-id + tracing; CORS for local/staging;
graceful shutdown; OpenAPI. **Verification gate:** Rust fmt/test/clippy pass; `/healthz` +
`/readyz` return 200. **dependsOn:** [3].

### Phase 5. Auth and Authorization (provider-agnostic JWKS) — ✅

**Objective:** Verify access-token JWTs against a **configurable** JWKS/issuer/audience and
derive admin/voter authority from the DB keyed on the verified `email` — designed so the IdP is a
config swap, not a code rewrite.

**Tasks (done, and confirmed IdP-portable):**
- `JwksCache` fetch+cache (RS256/384/512, ES256); `validate_token` checks signature/issuer/
  audience/exp/sub (`crates/api/src/auth/token.rs`).
- `CurrentUser` (`sub`→`Uuid`, normalized `email`), `AdminUser`, `is_admin_or_promote` (H5)
  keyed on `sub` + verified `email` — **not** on any token role claim, so it survives the swap.
- RUST-AUTH-2: drop an explicitly-unverified email so it cannot consume an admin invitation or
  voter slot — reads the **top-level `email_verified`** GCIP emits.

**Verification gate:** auth tests pass for valid / expired / malformed / **wrong-audience** /
**wrong-issuer** (the last two guard the GCIP repoint); `is_admin_or_promote` promotes only on a
matching pending invitation for a verified email. **dependsOn:** [4].

> **Auth-migration delta (Phase 18 wires this):** the only behavior that changes is configuration
> — `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWKS_URL` get GCIP values. The
> `user_metadata.email_verified` fallback becomes dead-but-harmless after the swap.

### Phase 6. Repository and Domain Service Layer — ✅

**Objective:** Separate storage/domain/HTTP. **Tasks:** sqlx repos (elections, admins,
admin_invitations, voters, submission_tickets, vote_submissions, artifacts, contract_deployments,
finalization_jobs); domain services (state transition, registration/finalization/completion
eligibility, vote-submit validation); transaction helpers. **Verification gate:** unit tests for
transitions/validation; `cargo test --workspace` green. **dependsOn:** [5].

### Phase 6.5. Node→Rust Code Deletion (cross-cutting) — 🆕

**Objective:** Retire the legacy Node `server/` from the codebase so Rust is the sole backend.
This is the code-level half of workstream (A) and a **hard precondition for Phases 16, 17, 20,
21**. Specified in full in `docs/superpowers/specs/2026-06-19-node-to-rust-migration-design.md`
(6 gated commits); summarized here so it occupies a slot in the dependency graph and the
cross-cutting "Delta" notes in Phases 2/17 have a phase to anchor to.

**Tasks (the spec's 6 commits, in order, each behind its CI-mirror gate):**
- **C1 Relocate the ZK toolchain:** `git mv server/zkp zk`; repoint `scripts/ci/check-artifact-schema.sh`,
  `scripts/local/fetch-ptau.sh`, `scripts/local/check-toolchain.sh`, the `scripts/deployAll.js`
  hint, the `ci.yml` shell-gate glob, **and `.gcloudignore`** (`server/zkp/{tmp,input,circomlib}/`
  → `zk/...`; drop `server/node_modules/`); add `circomlib` to the **root** `package.json`; copy
  the exact `build_4_5`/`build_5_4` bytes into `.data/zk-artifacts/` (invariant #7 — never regenerate).
- **C2 Vendor helpers:** copy `supabaseClient.js` / `fieldElement.js` / `zkArtifacts.js` into
  `scripts/`; repoint `etl-supabase-to-postgres.js`, `deployAll.js`, and the affected tests
  (this realizes the **Phase-20 ETL precondition** — no `require('../server/...')` may remain).
- **C3 Delete the Node app + ~21 tests + `ci.yml` lockstep** (realizes the **Phase-17 CI delta**:
  drop `npm ci --prefix server`, the server cache path, both `npm audit --prefix server`, narrow
  the JS gate `find server scripts test` → `find scripts test`, rename the `contracts-and-node` job).
- **C4 Frontend dev pointer + root-dep prune; C5 docs; C6 delete `deploy-backend.yml`** (last).

**Verification gate:** the full CI mirror passes after each commit — `npx hardhat test --no-compile`;
JS+shell syntax gates; Rust fmt/clippy/test; `npm test --prefix frontend -- --watchAll=false &&
npm run build --prefix frontend`. No `require('../server/...')` remains under `scripts/`;
`bash scripts/ci/check-artifact-schema.sh` passes against the relocated `zk/` glob.

**dependsOn:** [6] (Rust parity proven). **Blocks:** [16, 17, 20, 21].

### Phase 7. GCP Identity Platform Standup and User Migration — 🆕

**Objective:** Provision GCIP in the staging project (email/password + **email-verification
enforced**) and migrate Supabase users **preserving UUIDs and bcrypt passwords**, so no voter
re-registers and DB FKs stay intact. **Cost-gated + user-approved.**

**Tasks:**
- Enable `identitytoolkit.googleapis.com`: add it to `required_apis` in
  `scripts/gcp/zkvote-staging-setup.sh` (alongside the existing 9 APIs).
- Provision the GCIP/Firebase Auth tenant + the email/password provider; enable email
  verification (send verification links; GCIP does not autoconfirm password sign-ups).
  **Enforcement is at the app layer, not the provider:** GCIP has **no** "require verified email
  before sign-in" toggle for basic email/password — invariant #8 is carried by the backend
  reading the **top-level `email_verified`** claim (RUST-AUTH-2 drops an explicitly-unverified
  email). Configure verification + (optional) password-reset email templates + authorized
  domains/redirect URIs.
- **Partition the Supabase user population first** (a `SELECT` over `auth.users` / `identities`):
  **password users** (have a bcrypt hash) vs **OAuth-only users** (e.g. Kakao — **no** password
  hash). The two are migrated differently and the split is load-bearing for Phase 16 (Kakao
  decision) and Phase 20 (identity cross-check).
- **Password users — bulk import:** one-time, **idempotent** `scripts/migration/import-users-to-gcip.js`
  using the Firebase Admin SDK `getAuth().importUsers([...], { hash: { algorithm: 'BCRYPT' } })`,
  batched ≤1000/call. Per user set **`uid` = the existing Supabase UUID string**, `email`,
  `passwordHash` = the raw `$2a/$2b` bcrypt bytes, and **`emailVerified` = the user's actual
  Supabase verified status (NEVER unconditionally `true`)**.
- **OAuth-only users — explicit decision (tie to Phase 16 Kakao keep/drop):** either (a) configure
  the matching GCIP OIDC/OAuth provider and import them as federated identities **keeping
  `uid` = the Supabase UUID**, or (b) enroll them into email/password via a forced password-reset,
  or (c) **explicitly exclude** them with a documented lockout + user-comms plan. Whichever is
  chosen, record which `voters.user_id`/`admins.id` rows it covers so the Phase-20 cross-check is
  a partition match, not a false 1:1.
- **Close the non-UUID signup window:** until cutover (Phase 21), either **disable open GCIP
  self-registration** or route all new sign-ups through a UUID-minting provisioning path — a user
  created via normal GCIP sign-up gets a 28-char uid (not a UUID) and would `401` (§0.3).
- Keep the service-account JSON **out of the repo** (gitignored); run the import only with
  `CONFIRM_COSTS=yes` + explicit approval.
- Document that admin invite-by-listing-existing-auth-users (Node's Supabase Admin API in
  `addAdmins`, AR-L4; Rust `manage.rs` sets `promoted_existing_user: false`) is **not** offered in
  v1 — admin promotion stays DB-driven via verified-email invitations (no GCIP custom-claim authz).

**Config changes:** `zkvote-staging-setup.sh required_apis += identitytoolkit.googleapis.com`;
new gitignored `scripts/migration/import-users-to-gcip.js`; GCIP email/password (+ optional OAuth)
provider; self-registration disabled until cutover.

**Verification gate:**
- A test sign-in with a migrated **password** voter's existing password yields a GCIP ID token
  whose `sub` == that voter's old Supabase UUID and that carries a **top-level `email_verified`**.
- Re-running the import is idempotent (the script guards — `importUsers` does not dedupe and must
  not relax `emailVerified`).
- A Supabase-**un**verified user imports as `emailVerified:false` and is dropped as a join key by
  RUST-AUTH-2.
- The **OAuth-only partition** is fully accounted for: every such `voters.user_id`/`admins.id`
  either resolves to a migrated GCIP identity (with `uid`=UUID) or is on the documented-exclusion
  list — none silently 401.

**dependsOn:** [5].

### Phase 8. Read-Only Rust API Parity — ✅

**Objective:** Port low-risk read surfaces first (`GET /api/elections/{registerable,finalized,
completed}`); match frontend shapes/field names; route tests with seeded DB. **Verification
gate:** read-route responses byte-match Node shapes for fixtures; route tests green.
**dependsOn:** [6].

### Phase 9. Election Creation and Admin Setup — ✅

**Objective:** Port admin setup with strict validation (`POST /api/elections/set`,
`/:id/setZkDeploy`, `/api/management/addAdmins`). **Tasks:** ISO UTC dates; candidate
length/non-empty/trimmed-dedup; max candidate count; Merkle depth limits; artifact manifest/hash
availability before deploy; normalized admin emails; idempotent upsert; invitation acceptance /
auth-time promotion (verified email); no race-prone unlocked `/setZkDeploy`. **Verification
gate:** duplicate-label/over-limit candidates rejected; admin upsert idempotent; invited email
promoted on first authenticated lookup, unverified not. **dependsOn:** [8].

### Phase 10. Voter Allowlist and Registration — ✅

**Objective:** Port voter management + registration with race-safe locking and post-audit privacy
(`POST /api/elections/:id/voters`, `/:id/register`). **Tasks:** normalize emails; recheck
state/window inside the DB txn; recheck Redis/on-chain finalization markers; one voter row per
`user_id`; client keeps the secret, backend stores only the commitment/leaf; `OVER_CAPACITY`
guard at `2**depth` (AR-H2, backported to Node); voter-secret re-bind/export/passphrase UX
(AR-H6, matches on `user_id` UUID equality); lock timeout + tests. **Verification gate:**
registration binds `voters.user_id = token sub` (UUID) and rejects `OVER_CAPACITY`; AR-H6 re-bind
succeeds only for the same `user_id`; concurrent register is race-safe. **dependsOn:** [9].

### Phase 11. ZK Artifact Pipeline — ✅

**Objective:** Reliable artifact gen/store/manifest/retrieval with **beacon-finalized** zkeys.
**Tasks:** canonical manifest JSON (Postgres + files local/GCS); validate wasm/zkey/vkey/Solidity
verifier presence + sha256; beacon-finalize every zkey (`snarkjs zkey beacon` + independent
contributor, publish transcript, gate `snarkjs zkey verify`; single operator entropy unacceptable
— AR-H1); browser proving-artifact retrieval replacing Node's `/api/zkp-files` mount (Rust
streaming route or signed URLs, AR-M6) + per-artifact sha256 + frontend hash verification before
proving; track public-signal schema/length; Circom production v1; isolate Noir POC.
**Verification gate:** `snarkjs zkey verify` passes against the beacon-finalized zkey; frontend
verifies sha256 before proving. **dependsOn:** [10].

### Phase 12. Contract Deployment and Chain Integration — ✅

**Objective:** Contract deploy + relayer behind a typed Rust chain layer with **owner/relayer key
separation** (AR-M4). **Tasks:** per-env chain config; verifier deploy/lookup; `VotingTally`
deploy; deployment metadata in Postgres; `configureElection` preflight + tx submit; receipt
polling + failure classification; verifier/public-input compatibility with the manifest; on-chain
election-identity check; relayer key only in Secret Manager/`.env`; **distinct owner key**
(explicit owner or two-step `transferOwnership`) + rotation + gas monitoring; immutable on-chain
params after `configureElection` + supersede runbook (AR-M7). **Verification gate:** deploy +
`configureElection` succeed; metadata persisted; deploy script refuses if owner key == relayer
key. **dependsOn:** [11].

### Phase 13. Finalization Worker — ✅

**Objective:** Recoverable finalization job flow with **bit-identical Poseidon** (AR-H7).
**Tasks:** acquire election lock; write durable `finalizing` state before any on-chain side
effect; recheck deadline/state; validate voting end vs `max_voting_duration_days` (default 30,
AR-M7) with explicit confirmation to exceed; snapshot voters; reject zero-voter; `light-poseidon`
Merkle root (bit-identical to circom/circomlibjs); create `finalization_jobs` row; submit
`configureElection`; poll receipt; sync DB only after on-chain success; record partial failures;
lock fencing/renewal; revalidate snapshot. **Verification gate:** cross-language Poseidon test
vectors match (circuit / poseidon-lite / circomlibjs / light-poseidon); DB finalized only after
on-chain success; partial-failure path leaves a recoverable job. **dependsOn:** [12].

### Phase 14. Proof Ticket and Vote Submission — ✅

**Objective:** Port the privacy-critical voting path preserving anonymous-submit + ticket-binding
invariants (`POST /api/elections/:id/proof`, `/:id/submit`). **Tasks:** single-use ticket bound
to `(election_id, merkle_root)` **ONLY, never the nullifier** (AR-H5); no identity-to-ticket
logging (AR-M1); timing-linkage mitigation (client jitter, order-agnostic relayer queue, no
`/proof` timestamps, AR-M2); short ticket expiry; ticket-scoped Redis lock/Lua
read-validate-consume; validate proof/public-signal shapes; validate public `election_id` vs
route/ticket/DB/contract; candidate range; root vs finalized root; nullifier uniqueness vs
contract + durable records; contract preflight; per-wallet relayer tx serialization (AR-M5);
front-run reconciliation on duplicate-nullifier revert (AR-L8); persist status + tx hash;
failed-relay state safety; frontend loading/error handling; **no JWT extractor on submit
(invariant #1)**. **Verification gate:** `submit` accepts a valid ticket with **no Authorization
header** and rejects a reused/expired ticket; ticket payload carries no nullifier; logs carry no
identity→ticket linkage. **dependsOn:** [13, 7].

### Phase 15. Completion and Results — ✅

**Objective:** Port completion + final results (`POST /api/elections/:id/complete`). **Tasks:**
reject completion before `voting_end_time`; read on-chain tally (or trusted submission-derived
tally per the finalized decision); persist completed state once; frontend-compatible results;
define chain-read-failure behavior; re-verify `GET /api/elections/completed` shape (ported in
Phase 8 — do not re-port). **Verification gate:** completion before `voting_end_time` rejected;
results shape matches; completed state idempotent. **dependsOn:** [14].

### Phase 16. Frontend Integration and Auth SDK Swap (Supabase JS → Firebase/GCIP) — 🟡 (integration done; **SDK swap is new**)

**Objective:** Repoint the frontend to the Rust API **and replace the Supabase Auth client with
the Firebase Auth Web SDK** — the largest single code change of the migration — without changing UX.

> **Supersedes the migration spec.** `docs/superpowers/specs/2026-06-19-node-to-rust-migration-design.md`
> (written 2026-06-19, pre-GCIP-decision) KEEPs `frontend/src/supabase.js` and lists "frontend keeps
> Supabase auth" as out-of-scope. That is **superseded by §0** (2026-06-20): the SDK swap happens
> here, in Phase 16, *after* the spec's code-deletion commits (Phase 6.5). The spec's frontend
> notes are annotated accordingly.

**Tasks:**
- Add the `firebase` dependency (`firebase/app` + `firebase/auth`); remove `@supabase/supabase-js`.
  Replace `frontend/src/supabase.js` with a Firebase init using `REACT_APP_FIREBASE_API_KEY` /
  `_AUTH_DOMAIN` / `_PROJECT_ID` (the Firebase web `apiKey` is **public config, not a secret**).
- **Rewrite the login UI — it is multi-component, not one file:** `LoginPage.js` (coordinator),
  `EmailAuthForm` (`signInWithPassword` → `signInWithEmailAndPassword`; `signUp` →
  `createUserWithEmailAndPassword` + `sendEmailVerification` — **add the in-app verify prompt that
  did not exist before**; add `sendPasswordResetEmail`), `KakaoAuthButton` + the OAuth redirect
  handler (currently `supabase.auth.signInWithOAuth({provider:'kakao'})`).
- **Kakao OAuth — BLOCKING decision (tie to Phase 7 partition):** Kakao is a fully wired feature.
  Either (a) configure a GCIP OIDC/OAuth provider for Kakao and migrate those identities
  (`uid`=UUID), or (b) drop Kakao for v1 with a documented user-comms/lockout plan. **OAuth-only
  users have no bcrypt hash** so they cannot be password-imported in Phase 7 — this decision and
  that partition are the same decision. Do not leave it implicit.
- Rewrite `App.js` `AuthHandler`: `onAuthStateChange` → `onAuthStateChanged`; `getSession` → the
  Firebase `currentUser`; keep dispatching `setUser` and calling `GET /api/me` for `is_admin`
  (AR-H4, no direct table reads). Rewrite the axios interceptor (`frontend/src/api/axios.js`) to
  attach `Bearer await user.getIdToken()` instead of `supabase.auth.getSession().access_token`
  (note: `getIdToken()` is **async** vs Supabase's sync token — interceptor bugs can drop the
  bearer); **keep `skipAuth` on submit**. Update `axios.test.js` mocks and `authSlice` comments
  (Supabase user/session → Firebase user/IdToken).
- **Repoint the frontend CD build args:** `.github/workflows/deploy-frontend.yml` (and
  `frontend/buildspec.yml`) inject `REACT_APP_SUPABASE_URL`/`_ANON_KEY` at build time — change them
  to `REACT_APP_FIREBASE_*`, **or** keep the workflow `workflow_dispatch`-disabled until the
  hosting decision and explicitly forbid dispatching it with stale Supabase env (a build with
  undefined Firebase config ships a non-functional login).
- Convert `datetime-local` → ISO; switch read routes first, then writes by lifecycle; keep the
  **tagged pre-deletion Node image** as fallback until staging E2E passes; browser smoke tests for
  admin + voter flows.

**Config changes:** `frontend/package.json` `-@supabase/supabase-js, +firebase`; `frontend/.env`
+ `deploy-frontend.yml`/`buildspec.yml` build args `REACT_APP_SUPABASE_URL/_ANON_KEY` →
`REACT_APP_FIREBASE_API_KEY/_AUTH_DOMAIN/_PROJECT_ID`; `REACT_APP_API_BASE_URL` flag wired to Rust.

**Verification gate:** `npm test --prefix frontend -- --watchAll=false && npm run build --prefix
frontend` pass; a real GCIP login attaches a `getIdToken()` bearer the Rust API accepts and
`GET /api/me` returns correct `is_admin`; sign-up sends a verification email and an unverified
account is not treated as admin/voter; the Kakao decision is recorded and (if kept) a Kakao login
yields an accepted token. **dependsOn:** [15, 7, 6.5].

### Phase 17. CI/CD and Quality Gates — 🟡 (done; needs Firebase-secret + auth-config deltas)

**Objective:** Make regressions visible pre-deploy across Rust, contracts, circuit, frontend.
**Tasks:** Rust fmt/clippy/test; Hardhat + MockVerifier tests (success / dup nullifier /
wrong-election / wrong root / candidate overflow); circuit public-signal length+order checks;
migration verification; frontend build; **add an auth-config regression asserting
`validate_token` rejects wrong-issuer / wrong-audience** (guards the GCIP repoint); **update
frontend CI secrets `REACT_APP_SUPABASE_*` → `REACT_APP_FIREBASE_*`**; optional approval-gated
staging deploy; keep/disable legacy AWS workflows gated; `npm ci` against committed lockfiles
everywhere (AR-H8); dependency-audit jobs (`npm audit`/osv-scanner, `cargo audit`/`cargo deny`)
+ pin `snarkjs`/`circomlibjs`/`circomlib`; artifact commit policy.

**Verification gate:** CI green on a clean checkout; dependency-audit jobs pass; the
wrong-issuer/wrong-audience auth tests fail the build if the verifier is misconfigured.
**dependsOn:** [16, 6.5].

> **Delta (Node-deletion):** drop `npm ci --prefix server`, the `server` cache path, both
> `npm audit --prefix server` lines, and narrow the JS syntax gate `find server scripts test` →
> `find scripts test`; rename the `contracts-and-node` job. Edit in lockstep with the `server/`
> deletion (migration spec Commit 3).

### Phase 18. GCP Staging Infra Standup and Secret Repointing — 🆕

**Objective:** Provision the scripted GCP staging infra and wire Secret Manager / Cloud Run to
**GCIP** issuer/JWKS/audience instead of Supabase. **Cost-gated (`CONFIRM_COSTS=yes`) +
user-approved.**

**Tasks:**
- Run `scripts/gcp/zkvote-staging-setup.sh` (now including `identitytoolkit` + GCIP from Phase 7)
  to create Cloud Run, Cloud SQL Postgres 16 (`zkvote-staging-pg`, two DB users), Memorystore
  Redis 7, VPC connector, Artifact Registry, GCS artifact bucket, service account, per-secret
  IAM (M9).
- **Repoint auth secrets — and wire them into the deploy artifact (this is the footgun):** set the
  JWKS-URL secret to
  `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`
  (**not** the `/robot/v1/metadata/x509/` PEM endpoint). **Edit `scripts/gcp/deploy-staging-api.sh`**:
  its `--set-env-vars` currently carries only `ARTIFACT_STORE|CHAIN_ID|CORS_ALLOWED_ORIGINS` and it
  still binds `SUPABASE_URL` as a secret. Append `SUPABASE_JWT_ISSUER=https://securetoken.google.com/<PROJECT_ID>`
  and `SUPABASE_JWT_AUDIENCE=<PROJECT_ID>` (as env or secret bindings), **and remove the
  `SUPABASE_URL` binding** (or accept it as harmless *only* because the explicit issuer now
  overrides the `config.rs:76-78` derivation). Without this edit a verbatim deploy derives the
  **Supabase** issuer from `SUPABASE_URL` and **rejects 100% of GCIP tokens**. Optionally rename
  the secrets to `zkvote-staging-idp-*` in **both** setup + deploy scripts together.
- **Seed the GCS artifact bucket (otherwise proving fails on an empty bucket):** the setup script
  *creates* `gs://zkvote-staging-artifacts-<project>` but never populates it, and the Rust
  `artifacts.rs` streams `build_{depth}_{candidates}` objects from GCS. Add a `gcloud storage cp`
  of the **exact** `zk/build_4_5` + `zk/build_5_4` bytes + manifest into the canonical object paths
  that match `artifacts.rs` URL construction, preserving byte-identity (invariant #7) and
  cross-checking each `sha256` against the manifest after upload.
- Build + push the Rust image (`cloudbuild-staging-api.yaml`) to Artifact Registry; `gcloud run
  deploy zkvote-staging-api` with Cloud SQL attach, VPC connector, and secret env mounts
  (`DATABASE_URL`, `REDIS_URL`, `SUPABASE_JWKS_URL`=GCIP JWKS, `SUPABASE_JWT_ISSUER`,
  `SUPABASE_JWT_AUDIENCE`, `SEPOLIA_RPC_URL`, `RELAYER_PRIVATE_KEY`, `OWNER_PRIVATE_KEY`,
  `ARTIFACT_BUCKET`), staging CORS, minimal IAM.
- Ensure legacy AWS EC2/S3/CloudFront auto-deploy stays gated/disabled.

**Config changes:** `deploy-staging-api.sh` `--set-env-vars` gains `SUPABASE_JWT_ISSUER` +
`SUPABASE_JWT_AUDIENCE` and drops/neutralizes `SUPABASE_URL`; GCS bucket seeded with the exact
proving artifacts; Cloud Run env carries the GCIP issuer/audience/JWKS.

**Verification gate:** Cloud Run `/healthz` + `/readyz` return 200; Cloud SQL + Memorystore
reachable over the VPC connector; **assert the effective issuer == `https://securetoken.google.com/<PROJECT_ID>`
(not the derived Supabase value)**; a GCIP-issued ID token is accepted and a Supabase-issued token
is now rejected; a voter can **fetch wasm/zkey from GCS and the sha256 matches the manifest**;
secret access scoped to `zkvote-staging-*` only; no main-push triggers a live AWS deploy.
**dependsOn:** [17, 7].

### Phase 19. Security Re-audit and Privacy Review — 🟡 (2026-06 pass done; **GCIP boundary is new**)

**Objective:** Re-run the security review after Phase 1 + the Rust + IdP migrations and confirm no
blocker was reintroduced.

**Tasks:** reconcile every `audit.md` / `docs/SECURITY_AUDIT_2026-06.md` item (closed/accepted/
open-blocking); document trust boundaries incl. **the new GCIP token-issuance / email-verification
boundary**; **re-verify invariant #8 under GCIP** (verification enforced; imported users not
falsely `emailVerified`; `email_verified` read top-level); review nullifier/root/candidate signal
leakage; measure ticket-issuance-to-on-chain timing correlation in staging; decide on unlinkable
authorization + minimum anonymity-set/turnout threshold (AR-M1/AR-M2); record accepted v1 on-chain
visibility/receipt-ability (AR-L3); review admin scope, Secret Manager access, bucket IAM,
replay/double-vote, finalization race, client-held-secret privacy vs operators, deployed-artifact
-vs-manifest hash; **update `docs/SECURITY_REVIEW.md` + `docs/TECH_STACK.md` §auth + `CLAUDE.md`
invariant #8 to name GCIP as the IdP**.

**Verification gate:** no open Critical/High; the GCIP email-verification control is documented as
the invariant-#8 carrier; audit closure matrix (C1–H5, M1–M13) complete and current.
**dependsOn:** [18].

### Phase 20. Data ETL: Supabase Postgres → Cloud SQL — 🆕

**Objective:** One-time, **verified** migration of the four app tables into Cloud SQL, preserving
the Supabase UUIDs the GCIP uids now mirror. **Cost-gated + user-approved.**

**Tasks:**
- Run `scripts/migration/etl-supabase-to-postgres.js`: export hosted Supabase rows (`Elections` /
  `Voters` / `Admins` / `AdminInvitations`) into Cloud SQL with **row-count + checksum
  verification** (AR-H3). **Preserve `voters.id` ordering** (XCUT-4 Merkle-order invariant) and
  copy `admins.id` / `voters.user_id` **verbatim** (they must equal the GCIP uids set in Phase 7).
- Choose the cutover data strategy: write-freeze, or dual-write with a data-rollback path for
  Rust-written rows (AR-H3).
- **Cross-check:** the set of `admins.id` / `voters.user_id` in Cloud SQL equals the set of GCIP
  uids — no orphaned identities.

> **Hard precondition:** the ETL `require('../../server/utils/fieldElement')` (L23) and
> `require('../../server/supabaseClient')` (L144) only resolve after **Phase 6.5 Commit 2** vendors
> them into `scripts/`. Running Phase 20 before that commit crashes on a missing `require`.

**Config changes:** ETL run with `CONFIRM_COSTS=yes` + explicit approval; service-account /
Supabase creds gitignored.

**Verification gate:** migrated row-count + checksum match source per table (AR-H3); **the set of
`voters.user_id` / `admins.id` in Cloud SQL equals the set of provisioned GCIP uids** (accounting
for the Phase-7 OAuth-only partition — no row resolves to a non-existent identity); a migrated
voter signs in and appears in `list_voting_for_user`; `voters.id` ordering preserved (XCUT-4).
**dependsOn:** [19, 7, 6.5].

### Phase 21. Migration Cutover — 🆕

**Objective:** Move from Node-active to **Rust-active on GCIP auth**, with a rehearsed rollback.

**Tasks:**
- **Codebase precondition:** the Node→Rust deletion (migration spec Commits 1–6) is merged — Rust
  is the sole backend, `server/` removed, `zk/` relocated.
- Freeze the legacy API except critical fixes; run the retained pre-deletion Node image + Rust
  side by side in staging and compare compatibility-route responses.
- Switch frontend traffic in order: **reads → admin writes → registration/finalization →
  proof/submit last**. Cut auth over to GCIP for all users (frontend already on Firebase SDK from
  Phase 16; backend already validates GCIP tokens from Phase 18).
- **Rollback artifact set (all three, since `server/` and the Supabase SDK are gone from the
  tree):** `{ tagged pre-deletion Node image, tagged Supabase-auth frontend build, Supabase data
  snapshot }`. A backend-only rollback is **auth-incompatible** — a restored Node image expects
  Supabase JWTs while the live frontend (post-Phase-16) mints GCIP tokens, so the rehearsal **must
  also** revert the frontend to the Supabase-SDK build and re-point the Supabase auth secrets.
  Keep all three deployable until one full staging election lifecycle passes on Rust.

**Verification gate:** one full staging election E2E (create → allowlist → register → finalize →
proof → submit → complete) passes on Rust with GCIP auth; migrated row-count/checksum re-confirmed;
**rollback rehearsal restores the full set — Node image + Supabase-auth frontend + Supabase data —
and a user can sign in against the restored Supabase stack**. **dependsOn:** [20, 16, 6.5].

### Phase 22. Production Readiness — 🆕

**Objective:** Prepare production separately from staging, including a **production GCIP**
configuration.

**Tasks:** separate-named production GCP resources + secrets, incl. a production GCIP
tenant/project with email-verification enforced and production issuer/audience
(`https://securetoken.google.com/<prod-project>` / `<prod-project-id>`); plan the production user
import (or promote the same GCIP project) **keeping `uid` = UUID**; upgrade Cloud SQL tier +
consider HA; backup/restore policy; Redis persistence/failure behavior; domain/TLS/CORS/monitoring;
alerting (DB / Redis / Cloud Run / relayer / job backlog / **GCIP sign-in failures**); load +
concurrency tests for registration/finalization/submit.

**Verification gate:** restore test passes; staging load test demonstrates capacity; prod secrets
separate from staging; production GCIP issues tokens the prod API accepts and email-verification
is enforced. **dependsOn:** [21].

## 6. E2E Milestones

| Milestone | Phases | Exit criteria |
|---|---|---|
| **A. Local Rust Foundation** | 0–6 | Audit rebaseline done; local PG/Redis reproducible; Rust core stable; provider-agnostic auth in place |
| **B. Identity Migration Ready** | 7 | GCIP provisioned; Supabase users importable with `uid`=UUID + bcrypt + verified-status; a migrated user can sign in with `sub`=old UUID |
| **C. Rust Lifecycle Parity + Node deletion** | 6.5, 8–15 | Full admin+voter lifecycle reaches `completed` in Rust; legacy `server/` deleted (Rust sole backend); finalization recoverable; anonymous submit preserved |
| **D. Frontend on GCIP** | 16–17 | Frontend talks to Rust + Firebase Auth SDK; CI green incl. auth-config + Firebase-secret regressions |
| **E. Staging on GCP+GCIP** | 18–20 | Cloud Run accepts GCIP tokens (rejects Supabase); security re-audit clean; Cloud SQL ETL row/checksum-verified; ids resolve to GCIP users |
| **F. Cutover** | 21 | One full staging election E2E on Rust+GCIP; rollback rehearsed |
| **G. Production Candidate** | 22 | Prod infra + prod GCIP + monitoring/backups/rollback complete |

## 7. Suggested Immediate Next Work

1. **Execute the Node→Rust code deletion** (migration spec Commits 1–6): relocate `server/zkp` →
   `zk/`, vendor ETL/deploy deps, delete `server/` + CI lockstep, repoint frontend dev URL, docs,
   delete `deploy-backend.yml`.
2. **Phase 7 prep (no cost yet):** write `scripts/migration/import-users-to-gcip.js` and add
   `identitytoolkit.googleapis.com` to the setup script; **do not run** the GCIP enable/import
   until cost-approved.
3. **Phase 16 prep:** scaffold the Firebase Auth SDK swap behind the existing API-base-URL flag;
   decide the Kakao OAuth keep-or-drop.
4. **Phase 17 deltas:** add the wrong-issuer/wrong-audience auth regression; stage the
   `REACT_APP_SUPABASE_* → REACT_APP_FIREBASE_*` CI-secret rename.
5. **Doc reconciliation:** update `docs/TECH_STACK.md` §auth and `CLAUDE.md` invariant #8 to name
   GCIP (Phase 19 finalizes this).
6. **Gate everything cost-incurring** (GCIP enable, import, infra standup, ETL) on explicit
   approval; keep `main` frozen.

## 8. Environment Variable Migration Matrix

| Variable | Old (Supabase) | New | Used by |
|---|---|---|---|
| `SUPABASE_JWKS_URL` | `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` | `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` (**not** the x509 PEM endpoint) | `config.rs:117`, Cloud Run secret, `.env.example` |
| `SUPABASE_JWT_ISSUER` | unset → derived `{SUPABASE_URL}/auth/v1` | **must set** `https://securetoken.google.com/<PROJECT_ID>` | `config.rs:76-78,118`, `deploy-staging-api.sh` |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` | `<PROJECT_ID>` (bare id) | `config.rs:119-120`, `token.rs` |
| `SUPABASE_URL` | Supabase project URL | **unused for auth** once issuer is explicit (was legacy Node data plane) | `config.rs:77` |
| `REACT_APP_SUPABASE_URL` | Supabase URL | `REACT_APP_FIREBASE_AUTH_DOMAIN` (+ `_PROJECT_ID`) | `frontend/src/supabase.js`→firebase init, `frontend/.env` |
| `REACT_APP_SUPABASE_ANON_KEY` | Supabase anon key | `REACT_APP_FIREBASE_API_KEY` (public web key, **not** a secret) | frontend init, `frontend/.env` |
| `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_KEY` | service-role / anon (legacy Node data plane) | **removed** after Node→Rust + ETL (not part of the IdP swap) | `server/.env` (deleted) |
| `DATABASE_URL` | Supabase Postgres DSN | Cloud SQL unix-socket DSN `host=/cloudsql/<conn>` (`zkvote_app`) | `config.rs:100`, secret |
| `(migrator) DATABASE_URL` | n/a | Cloud SQL DSN with `zkvote_migrator` DDL role | secret, `db/roles.sql` |
| `REDIS_URL` | local/dev | `redis://<memorystore-host>:6379` over VPC connector | `config.rs:101`, secret |
| `ARTIFACT_STORE` / `ARTIFACT_BUCKET` | local | `gcs` / `zkvote-staging-artifacts-<project>` | `config.rs:80-109` |
| `OWNER_PRIVATE_KEY` vs `RELAYER_PRIVATE_KEY` | — | stay **DISTINCT** secrets (AR-M4); unchanged by IdP swap | Secret Manager |
| GCP `required_apis` | 9 existing | **+ `identitytoolkit.googleapis.com`** | `zkvote-staging-setup.sh:26-36` |
| Firebase Admin SA JSON | n/a | **NEW**, gitignored, one-time import script only | `import-users-to-gcip.js` (new) |

## 9. Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **`sub`-format break** (GCIP 28-char uid vs `Uuid::parse_str`, `auth/mod.rs:90-92`) | Every request 401s and matches no DB row | Set GCIP `uid` = existing Supabase UUID at `importUsers`; provision all identities with UUID uids; **verify in staging before cutover**; invasive fallback = `CurrentUser.id: String` + column migration |
| **x509 vs JWK endpoint** | Wrong (PEM) URL makes the `KeySet` parser reject all keys → all auth fails | Use `/service_accounts/v1/jwk/` only |
| **Issuer-default footgun** | Unset `SUPABASE_JWT_ISSUER` derives the Supabase issuer → rejects every GCIP token | Set it explicitly to `https://securetoken.google.com/<PROJECT_ID>` |
| **Audience mismatch** | Leaving default `authenticated` rejects all GCIP tokens | Set `SUPABASE_JWT_AUDIENCE=<PROJECT_ID>`; update test fixtures |
| **`email_verified` weakening** | If verification off or imports set `emailVerified:true` unconditionally, invariant #8 breaks (claim another's inbox) | Enforce GCIP verification; import `emailVerified` = true Supabase status only; rely on the top-level claim |
| **Frontend rewrite regression** | Largest code change; `getIdToken()` is async vs Supabase sync token → interceptor can drop the bearer; new verify/reset flows | Careful interceptor port + `axios.test.js`; browser smoke tests; keep Node fallback until E2E |
| **Kakao OAuth gap** | No automatic GCIP equivalent → OAuth-only users locked out | Configure a GCIP OIDC provider **or** drop Kakao for v1 with a recorded decision |
| **ETL/import ordering coupling** | If `admins.id`/`voters.user_id` and GCIP uids diverge, migrated users don't resolve | Run GCIP import (Phase 7) before/with the ETL (Phase 20); cross-check the id sets |
| **Cost-gate / shared-project** | GCIP enable, import, standup, ETL bill a shared POC project | `CONFIRM_COSTS=yes` + explicit approval for each; never run unapproved |
| **Plan/doc contradiction** | `TECH_STACK.md`/`CLAUDE.md` still say "keep Supabase Auth" | This plan supersedes; reconcile docs in Phase 19 |
| **`addAdmins` Admin-API gap (AR-L4)** | Rust `manage.rs:144` returns false; no invite-by-listing-auth-users | v1 keeps DB email-invitation flow; document the gap |
| C1/H1/H2/H3/H4/H5 (closed) | Overvote / forge / deanonymize / unrecoverable election / silent admin failure | Circuit v2, client-held secret, durable lifecycle state, invitation acceptance (see Phase 1) |
| Owner/relayer key conflation (AR-M4) | Relayer-key leak can freeze an election | Distinct cold owner / hot relayer keys in Secret Manager |
| ZK artifact mismatch / non-beacon zkey | Invalid proofs / deployed-election breakage | Manifest + sha256 + `snarkjs zkey verify` gate (AR-H1) |
| Live AWS auto-deploy during migration | Incomplete work reaches EC2/S3/CloudFront | `workflow_dispatch`-gate / disable legacy CD; `main` frozen |

## 10. Completion Definition for the Whole Project

The project is complete for the first production candidate only when:

- Admin and voter flows pass end-to-end in GCP staging through the frontend on **GCIP auth** and
  the **Rust** backend.
- All Critical/High audit findings are closed or reclassified with code-backed evidence; staging
  blockers from Medium findings are fixed or tracked.
- **Rust is the sole backend; the legacy Node `server/` is deleted** and no Supabase dependency
  remains in the runtime path (auth on GCIP, data on Cloud SQL).
- The IdP swap preserves invariant #8: GCIP email-verification enforced; identities keyed on
  UUID `sub` = old Supabase UUID; bcrypt passwords migrated; no voter re-registration.
- ZK artifacts are versioned, integrity-checked, beacon-finalized, and stored outside source-only
  paths; the production circuit exposes/verifies `election_id`, constrains Merkle path indices,
  and uses the post-audit public-signal order everywhere.
- Voter secrets are never generated, stored, or returned by the backend.
- Contracts are deployed/linked through reproducible tooling with owner ≠ relayer keys.
- Submission replay, mismatch, and duplicate-nullifier cases are tested; finalization recovers
  from partial DB/chain failures.
- Production infra, GCIP, monitoring, backups, IAM, and a rehearsed rollback are documented and
  verified, separate from staging.
