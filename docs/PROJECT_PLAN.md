# zk-vote End-to-End Project Plan

## 1. Goal

Build zk-vote as a production-oriented zero-knowledge voting system with this
target architecture:

```text
React frontend
  -> Rust API backend
    -> PostgreSQL
    -> Redis
    -> ZK artifact storage
    -> Ethereum relayer
      -> VotingTally + Groth16 verifier contracts
```

The current Node/Express backend remains the reference implementation until the
Rust backend reaches verified route parity. The migration must preserve the
existing public API behavior where possible, while tightening lifecycle state,
input validation, race handling, artifact integrity, and deployment operations.

## 2. Current Baseline

Already present in the repository:

- Node/Express backend with election creation, voter allowlisting,
  registration, finalization, proof ticket issue, vote submission, and
  completion routes.
- React frontend using Supabase Auth and browser-side proof generation.
- Solidity `VotingTally` and generated Groth16 verifier contracts.
- Circom/snarkjs circuit setup scripts and generated artifacts.
- Local Postgres and Redis via Docker Compose.
- GCP staging bootstrap script for Cloud SQL, Memorystore Redis, GCS artifact
  bucket, Secret Manager, VPC connector, and service account.
- Rust workspace scaffold with `/healthz`, `/readyz`, DB migration, and base
  crates.

Security audit baseline:

- `audit.md` is the current security review source until it is promoted to
  `docs/SECURITY_REVIEW.md`.
- Current code is suitable for local development/demo only, not staging or
  production election use.
- Audit blockers C1/H1/H2 must be closed before any staging E2E claim:
  - C1: `election_id` is private in the circuit and is not checked on-chain.
  - H1: `pathIndices` lacks boolean constraints in the Merkle proof circuit.
  - H2: backend generates, stores, and returns plaintext voter secrets.
- Audit blockers H3/H4 must be closed before deployment/finalization can be
  treated as operationally safe.
- Audit blocker H5 (admin invitations are never consumed) must be closed before
  invitation-based admin provisioning is relied upon.
- Medium audit items M1-M13 form the staging-readiness backlog; the subset that
  blocks staging safety is pulled into the Phase 1 rebaseline (see Phase 1), and
  the remainder follows the critical/high blockers.

Known direction:

- Production ZK path: Circom/Groth16.
- Noir: separate POC only.
- Auth: keep Supabase Auth, validate JWT/JWKS in Rust.
- Database: PostgreSQL.
- Cache/lock/tickets: Redis.
- Chain: Solidity + Ethereum-compatible relayer.
- Plan ordering is security-first: ZK soundness and privacy repairs precede
  Rust route parity, GCP staging, and cutover work.

## 3. Project Principles

- Preserve Node route behavior until Rust parity is proven.
- Treat the current Node backend as a behavioral reference, not as code to copy
  directly.
- Keep submit anonymous. Do not require JWT on final vote submission unless the
  privacy model is redesigned.
- Make election lifecycle explicit with a state machine instead of inferred
  boolean and timestamp combinations.
- Store all durable state in Postgres; use Redis for locks, short-lived proof
  tickets, and runtime coordination only.
- Every phase must have a concrete verification gate before the next phase can
  depend on it.
- No Cloud Run staging E2E, live AWS deployment, or production-candidate claim
  may proceed while any Critical or High item in `audit.md` remains open.
- Treat audit findings as planning inputs, not as optional post-production
  hardening.

## 4. Target E2E Product Flow

This flow describes the post-audit target. The current implementation does not
yet satisfy the ZK soundness and privacy requirements in this section.

### Admin Flow

1. Admin signs in through Supabase.
2. Admin creates an election draft.
3. Backend validates dates, candidates, Merkle depth, and initial state.
4. ZK artifacts are selected or generated for `(depth, candidate_count)`.
5. Verifier and `VotingTally` contracts are deployed or linked from an artifact
   manifest whose hashes match the stored election artifact version.
6. Admin opens registration.
7. Admin allowlists voters by email.
8. Eligible voters complete registration using a client-held secret and bind
   only a secret commitment/leaf to durable backend state.
9. Admin finalizes registration after the deadline or after an explicit
   fail-closed state transition that prevents further registration.
10. Backend snapshots voters, computes Merkle root, configures contract, and
    marks voting active.
11. After voting ends, admin completes the election.
12. Backend reads or aggregates final tally and marks the election completed.

### Voter Flow

1. Voter signs in through Supabase.
2. Frontend lists elections where the voter can register.
3. Voter registers for an allowlisted election.
4. Frontend lists active finalized elections.
5. Voter requests Merkle proof and one-time submit ticket.
6. Frontend generates the ZK proof locally using the client-held secret.
7. Voter submits proof, public signals, candidate index, and ticket.
8. Backend validates ticket binding, proof shape, public signals, candidate
   range, nullifier uniqueness, and contract preflight.
9. Backend relays the vote transaction.
10. The application surfaces results only through the completed election
    surface. Note (accepted v1 property, AR-L3): on-chain data is public —
    running tallies (`voteCounts`) and per-vote candidate choices (calldata,
    `VoteCast`) are readable during voting by anyone with chain access, and a
    voter holding their secret can prove how they voted. Hiding these would
    require a commit-reveal or aggregated-tally protocol redesign, which is
    out of scope for v1 and recorded in the Phase 18 threat model.

## 5. Phase Plan

### Phase 0. Project Governance and Scope Lock

Objective:

Define what is in scope for the first production-shaped version and prevent
architecture drift while migration work is underway.

Tasks:

- Keep `AGENT.md` as the agent-facing repository map.
- Keep this file as the execution plan.
- Create a short API compatibility matrix for every current Node route.
- Identify which Node routes are admin-only, voter-authenticated, anonymous, or
  public.
- Define environments: local, staging, future production.

Deliverables:

- `docs/PROJECT_PLAN.md`.
- `docs/API_COMPATIBILITY.md`.
- Environment naming convention documented for local and staging.

Verification gate:

- Every existing route in `server/index.js` appears in the compatibility matrix.
- Each route has owner, auth mode, request body, response shape, and error
  behavior notes.

Definition of done:

- The team can answer whether a Rust route is compatible with Node without
  reading the Node implementation from scratch.

### Phase 1. Audit Blocker Rebaseline

Objective:

Close the security and privacy blockers identified in `audit.md` before
staging, Rust route parity, or production-shaped deployment work depends on the
current ZK and lifecycle design.

This phase is a hard gate. It is intentionally placed before local/Rust
expansion because C1/H1/H2 invalidate the current voting security model, while
H3/H4 make setup/finalization unsafe under realistic retry and failure modes.

Tasks:

- Promote or copy `audit.md` to `docs/SECURITY_REVIEW.md` when the report is
  ready to become the canonical security-review artifact.
- Fix C1/H1 with a circuit/contract v2:
  - expose `election_id` as a public signal or public output;
  - add boolean constraints for every `pathIndices[i]`;
  - regenerate wasm, zkey, verification key, and Solidity verifier artifacts;
  - update `VotingTally`/`IVerifier` to the new public input length/order;
  - update Node submit validation, frontend submit payload handling, and tests
    to the new public signal shape.
- Fix H2 by redesigning the voter secret model:
  - client generates and stores the high-entropy voter secret;
  - backend stores only a leaf/commitment needed for Merkle membership;
  - `/proof` never returns plaintext `user_secret`;
  - backend no longer derives nullifiers from server-held secrets.
- Fix H3/H4 with durable lifecycle safety:
  - add `/setZkDeploy` lock or durable deployment marker;
  - bind elections to artifact manifests and hashes;
  - record `finalizing` or equivalent fail-closed state in Postgres before
    on-chain configuration;
  - add finalize lock fencing or lock renewal;
  - revalidate the voter snapshot before DB sync after on-chain success.
- Fix M13 registration-lock robustness (AR-L10): raise the `addUserSecret`
  registration lock timeout above worst-case tree work, and recheck lock
  ownership (fencing token) immediately before the `Voters` update commits.
- Fix H5 admin provisioning before relying on invitations:
  - implement invitation acceptance or auth-time promotion from
    `AdminInvitations`;
  - fail visibly if existing-user promotion fails.
- Fix M1/M12 vote-submit UX and replay behavior:
  - consume tickets only after validation through a ticket-scoped Redis lock or
    Lua read-validate-consume script;
  - handle frontend submit failures and clear loading state.
- Fix M2/M4/M5 artifact and setup readiness:
  - provision `.ptau` files with checksum verification;
  - install or document `circom`;
  - enforce candidate-count limits and duplicate-candidate rejection;
  - bind generated artifacts to circuit version/hash, not only
    `(depth, candidates)`.
- Fix M9/M10/M11 deployment safety before staging:
  - scope Secret Manager access per `zkvote-staging-*` secret;
  - write Cloud SQL database URL secret immediately after SQL user creation;
  - gate or disable live AWS EC2/S3/CloudFront auto-deploy workflows from main.

Deliverables:

- `docs/SECURITY_REVIEW.md` or an explicit statement that `audit.md` remains
  the temporary canonical review.
- Circuit/contract v2 artifacts and contracts.
- Updated Node/frontend proof-submit boundary.
- Client-held-secret registration/proof design.
- Durable deployment/finalization state design and implementation.
- Ticket consume atomicity implementation.
- CI tests covering the fixed failure modes.

Verification gate:

- A registered voter cannot produce two accepted votes by varying
  `election_id`.
- A proof with non-boolean Merkle path indices is rejected by the verifier.
- `/proof` responses do not include plaintext voter secrets.
- Successful proof/submit path works with the new public signal shape.
- MockVerifier or equivalent tests cover success, duplicate nullifier,
  wrong-election public signal, wrong root, and invalid candidate cases.
- Concurrent `/setZkDeploy` requests cannot generate mismatched artifacts or
  double-advance election deployment state.
- Registration fails while finalization is durably in progress.
- Finalization can recover from on-chain-success/DB-failure scenarios.
- Ticket replay, ticket mismatch, relayer preflight failure, and frontend
  submit failure are tested.
- GCP IAM and AWS CD gates reflect the audit mitigations.

Definition of done:

- All Critical and High findings in `audit.md` are closed or explicitly
  reclassified with code-backed evidence.
- Medium findings that block staging safety (M1, M2, M3, M4, M5, M9, M10, M11,
  M12, M13) have concrete fixes or are intentionally tracked as staging
  blockers.
- Only after this phase can later Rust, staging, and cutover milestones make
  security or readiness claims.

### Phase 2. Local Development Foundation

Objective:

Make local development reproducible for backend, DB, Redis, contracts, and ZK
tooling.

Tasks:

- Keep Docker Compose for Postgres 16 and Redis 7.
- Keep `.env.example` aligned with Rust and Node local requirements.
- Add a local setup command or script that runs infra smoke checks and DB
  migrations.
- Add Circom installation checks and `.ptau` provisioning instructions.
- Keep `snarkjs` invocation aligned with local `node_modules/.bin/snarkjs` or
  `npx`; do not require a global `snarkjs`.
- Add Noir setup instructions without making Noir part of production v1.

Deliverables:

- Working `docker-compose.yml`.
- Local smoke script.
- Toolchain check script.
- Local migration workflow.
- `.ptau` acquisition/checksum instructions or script.

Verification gate:

```bash
bash scripts/local/smoke.sh
cd rust-backend && cargo fmt --check
cd rust-backend && cargo test --workspace
cd rust-backend && cargo clippy --workspace -- -D warnings
```

Definition of done:

- A new developer can bring up Postgres, Redis, and the Rust API locally without
  touching GCP, and can see exactly which ZK toolchain pieces are missing.

### Phase 3. Data Model and Migration Hardening

Objective:

Make Postgres the durable source of truth for the future Rust backend.

Tasks:

- Review `rust-backend/migrations/0001_initial.sql` and
  `0002_node_api_compatibility.sql` against actual Node data usage (audit M6:
  the compatibility migration uses lowercase snake_case tables while Node uses
  PascalCase PostgREST tables).
- Add missing columns only if they are needed for route parity.
- Add `updated_at` triggers or explicit repository-level update handling.
- Add indexes for list pages and status transitions.
- Define the canonical election state transitions.
- Decide how existing Supabase table data maps into the new Postgres schema.
- Decide whether Rust uses lowercase tables only, PascalCase compatibility
  views, or quoted PascalCase tables for Node/PostgREST parity.
- Resolve `elections.circuit_id` default/nullability before claiming Node route
  compatibility (audit M7).
- Decide whether field elements are stored as `text` with numeric checks or as
  `numeric(78,0)` with explicit serialization rules (audit M8).
- Define the Cloud SQL privilege model (AR-M3). Decision: no RLS in Cloud SQL
  — PostgREST goes away and all access flows through the backend (the
  frontend's remaining direct table reads are removed by AR-H4's `/api/me`).
  Instead: separate a migration-owner role (DDL) from the runtime application
  role, grant the runtime role only the DML it needs per table, and inventory
  the current hosted-Supabase RLS posture being replaced so no anon-readable
  surface is silently lost.

Deliverables:

- Finalized initial migration.
- State transition documentation.
- Migration notes for existing data, if any.
- Node-to-Rust schema mapping decision for `Elections`/`Voters`/`Admins` and
  submission tables.

Verification gate:

- Duplicate voter email per election is rejected.
- Duplicate voter `user_id` per election is rejected.
- Duplicate nullifier per election is rejected.
- Invalid election state is rejected.
- Invalid election date ordering is rejected.
- Node-style election creation data can be represented without a
  `circuit_id` not-null failure.
- BigInt field elements round-trip byte-identically at the storage layer
  (text + format CHECK; measured by `scripts/local/db-verify.sh`). The
  API-level round-trip is re-verified when the Phase 13 routes exist
  (AR-L11: the original wording was untestable at Phase 3).
- The runtime database role cannot execute DDL; migrations run only under the
  owner role.

Definition of done:

- The database enforces the core invariants even if an API bug is introduced.

### Phase 4. Rust Backend Core

Objective:

Build the common Rust API foundation before porting business routes.

Tasks:

- Split `crates/api/src/main.rs` into modules:
  - config
  - error
  - state
  - routes
  - middleware
- Add typed application errors and JSON error responses.
- Add request ID and structured tracing.
- Add CORS configuration for local and staging origins.
- Add graceful shutdown.
- Add OpenAPI generation after route shapes stabilize.

Deliverables:

- Rust API module structure.
- Shared error response format.
- Tracing and request logging.
- Health and readiness endpoints.

Verification gate:

```bash
cd rust-backend && cargo fmt --check
cd rust-backend && cargo test --workspace
cd rust-backend && cargo clippy --workspace -- -D warnings
curl http://127.0.0.1:18080/healthz
curl -i http://127.0.0.1:18080/readyz
```

Definition of done:

- New Rust routes can be added without each route re-solving config, error, DB,
  Redis, and response conventions.

### Phase 5. Auth and Authorization

Objective:

Keep Supabase Auth while moving authorization checks into Rust.

Tasks:

- Implement JWKS fetch and cache.
- Verify JWT signature, issuer, audience, expiry, and subject.
- Define `CurrentUser` extractor.
- Implement admin authorization using the current admin source of truth.
- Normalize email consistently at API boundaries.
- Define which endpoints are anonymous by design.

Deliverables:

- Supabase JWT middleware.
- Admin middleware.
- Auth tests with valid, expired, malformed, and wrong-audience tokens.

Verification gate:

- Admin-only routes reject non-admin users.
- Voter-authenticated routes reject missing or invalid JWTs.
- Anonymous submit remains anonymous but still validates ticket and proof.

Definition of done:

- Rust can enforce the same or stricter auth behavior as Node without changing
  the privacy model.

### Phase 6. Repository and Domain Service Layer

Objective:

Separate storage, domain rules, and HTTP handlers before porting the lifecycle.

Tasks:

- Add repositories for:
  - elections
  - admins
  - admin invitations
  - voters
  - submission tickets
  - vote submissions
  - artifacts
  - contract deployments
  - finalization jobs
- Add domain services for:
  - election state transition
  - registration eligibility
  - finalization eligibility
  - vote submission validation
  - completion eligibility
- Add transaction helpers for multi-row state changes.

Deliverables:

- `zkvote-db` repository modules.
- `zkvote-domain` service modules.
- Unit tests for transition and validation rules.

Verification gate:

- Domain tests cover valid and invalid state transitions.
- Repository tests cover unique constraints and transaction rollback.

Definition of done:

- HTTP route handlers become thin adapters over tested services.

### Phase 7. Read-Only Rust API Parity

Objective:

Port low-risk list and detail surfaces first.

Routes:

- `GET /api/elections/registerable`
- `GET /api/elections/finalized`
- `GET /api/elections/completed`

Tasks:

- Match current frontend response shapes.
- Add pagination or explicit no-pagination decision.
- Preserve frontend-compatible field names during migration.
- Add route-level tests with seeded DB state.

Deliverables:

- Read-only Rust route implementations.
- Compatibility tests against documented Node response shapes.

Verification gate:

- Frontend can read from Rust for these routes behind the existing
  `REACT_APP_API_BASE_URL` flag (AR-L9: the flag predates Phase 15; no
  forward dependency remains).
- Existing Node route behavior remains unchanged.

Definition of done:

- The first API surface can be switched without affecting election writes.

### Phase 8. Election Creation and Admin Setup

Objective:

Port admin election setup while making date, candidate, and artifact validation
strict.

Routes:

- `POST /api/elections/set`
- `POST /api/elections/:election_id/setZkDeploy`
- `POST /api/management/addAdmins`

Tasks:

- Validate ISO UTC date inputs.
- Validate candidate list length and non-empty labels.
- Enforce a product-supported maximum candidate count before any circuit setup.
- Reject duplicate candidate labels after trimming.
- Enforce Merkle depth limits.
- Check artifact manifest and artifact hash availability before allowing
  deploy/setup state.
- Normalize admin emails.
- Implement idempotent admin upsert.
- Implement admin invitation acceptance or auth-time promotion before treating
  invitations as a full admin provisioning flow.
- Do not expose `/setZkDeploy` as a long-running, race-prone request without a
  lock, durable deployment marker, or background job.

Deliverables:

- Rust create-election route.
- Artifact selection/linking route.
- Admin management route.
- Tests for date normalization, invalid candidate lists, and duplicate admin
  upsert.
- Tests for candidate overflow, duplicate candidates, and invitation
  acceptance/promotion failure.

Verification gate:

- Malformed dates are rejected.
- Local `datetime-local` frontend values are converted to ISO strings before
  reaching the backend.
- Missing ZK artifacts block deployment setup.
- Concurrent setup/deploy attempts are rejected, queued, or idempotently
  returned without generating mismatched artifacts.

Definition of done:

- Admin can create a valid draft election in Rust and the resulting DB row can
  drive the later lifecycle phases.

### Phase 9. Voter Allowlist and Registration

Objective:

Port voter management and registration with race-safe locking.

Routes:

- `POST /api/elections/:election_id/voters`
- `POST /api/elections/:election_id/register`

Tasks:

- Normalize allowlisted emails.
- Recheck election state and registration window inside the DB transaction.
- Recheck Redis/on-chain finalization markers before accepting registration.
- Ensure one voter row can bind to only one `user_id`.
- Preserve the post-audit privacy model:
  - client generates and keeps the voter secret;
  - backend stores only commitment/leaf material;
  - backend never stores or returns plaintext `user_secret`.
- Enforce Merkle capacity: reject allowlist additions and registrations once
  the voter count would exceed `2 ** merkle_tree_depth`, with a typed
  `OVER_CAPACITY` error, before tree construction can throw `Tree is full`
  (architecture review AR-H2). Backport the same guard to the Node reference.
- Design the voter secret lifecycle (AR-H6):
  - authenticated commitment re-binding ("reset my registration") until
    `registration_end_time`;
  - secret export/import or passphrase-derived secret UX for device moves;
  - explicit messaging that post-finalization secret loss is unrecoverable.
- Add lock timeout behavior and tests.

Deliverables:

- Rust voter allowlist route.
- Rust registration route.
- Registration service tests.

Verification gate:

- Registration after finalization is rejected.
- Registration after deadline is rejected.
- Duplicate email allowlist is idempotent or returns a defined conflict.
- Concurrent registration attempts cannot bind multiple users to one voter row.
- Registration beyond `2 ** merkle_tree_depth` capacity is rejected with
  `OVER_CAPACITY` before any tree build can throw.
- A voter who lost their secret can re-bind a new commitment before
  finalization and subsequently vote with it.
- `/proof` can later be generated without the backend knowing the voter's
  plaintext secret.

Definition of done:

- Voter registration is correct under deadline, finalization, and concurrency
  pressure.

### Phase 10. ZK Artifact Pipeline

Objective:

Make ZK artifact generation, storage, manifesting, and retrieval reliable.

Tasks:

- Define canonical artifact manifest JSON.
- Store manifest in Postgres and artifact files in local/GCS storage.
- Validate `.wasm`, `.zkey`, verification key, and Solidity verifier presence.
- Add sha256 checks for every artifact.
- Finalize every per-election zkey with a public random beacon
  (`snarkjs zkey beacon`) and/or at least one independent phase-2 contributor;
  publish the contribution transcript and gate on `snarkjs zkey verify`.
  A single operator-run contribution with operator-known entropy is not
  acceptable for staging or production elections (AR-H1).
- Define the browser-facing proving-artifact retrieval surface that replaces
  Node's `/api/zkp-files` static mount after cutover: a Rust route streaming
  wasm/zkey from manifest/GCS storage, or signed URLs returned by `/proof`
  (AR-M6).
- Expose per-artifact sha256 from the manifest to clients, and have the
  frontend verify fetched wasm/zkey hashes before proving — refuse to generate
  a proof on mismatch (AR-M6; client-side trust ceiling for the H2 model).
- Track circuit public signal schema, including election identity position and
  expected public input length.
- Treat the C1/H1-fixed circuit as production v1 for any new staging election.
- Keep Circom as production v1.
- Scaffold Noir POC separately so it cannot affect production artifact
  selection.

Deliverables:

- Artifact manifest schema.
- Artifact storage abstraction.
- Local artifact import command.
- GCS artifact upload/download command.
- Artifact integrity tests.

Verification gate:

- Missing artifact file blocks election setup.
- Hash mismatch blocks artifact use.
- A zkey finalized without a beacon or independent contribution is rejected
  for staging elections.
- The frontend refuses to prove when the served wasm/zkey hash does not match
  the manifest.
- Public signal schema mismatch blocks artifact use.
- Local and GCS artifact URI layouts match documented conventions.

Definition of done:

- A circuit version can be promoted from local generation to staging storage
  without manual path edits.

### Phase 11. Contract Deployment and Chain Integration

Objective:

Move contract deployment and relayer calls behind a typed Rust chain layer.

Tasks:

- Define chain configuration by environment.
- Implement verifier deployment or lookup.
- Implement `VotingTally` deployment.
- Store deployment metadata in Postgres.
- Add `configureElection` preflight and transaction submission.
- Add transaction receipt polling and failure classification.
- Enforce verifier/public-input compatibility with the circuit artifact
  manifest.
- Ensure `VotingTally` checks the public election identity before accepting a
  proof.
- Keep relayer private key only in Secret Manager or local `.env`.
- Separate the contract owner key from the hot relayer key: pass an explicit
  owner to the `VotingTally` constructor (or add two-step `transferOwnership`)
  so the internet-exposed relayer key holds no `onlyOwner` privileges; define
  rotation and relayer gas-balance monitoring (AR-M4).
- Lifecycle policy decision (AR-M7): on-chain election parameters stay
  immutable after `configureElection` — no extend/cancel/pause functions,
  because a mid-election mutable owner is a larger governance risk than
  immutability. Compensating controls: finalize-time duration bounds
  (Phase 12) and a documented "supersede election" runbook — mark the
  election superseded in the DB and create a replacement election row for the
  new contract. The superseded row remains immutable and hidden from vote
  flows.

Deliverables:

- `zkvote-chain` deployment and contract clients.
- Deployment job or command.
- Contract deployment repository integration.

Verification gate:

- Deployment cannot run without artifact manifest.
- Duplicate deployment for the same election is rejected or idempotently
  returned.
- Failed transaction does not advance DB state.
- A proof generated for another election cannot pass `submitTally`.
- The hot relayer key cannot call `configureElection` on a freshly deployed
  `VotingTally`.
- A superseded election cannot accept app-relayed votes, and a replacement
  election can be deployed without mutating the abandoned row.

Definition of done:

- Rust can deploy/link contracts and persist chain metadata without Node
  scripts.

### Phase 12. Finalization Worker

Objective:

Port finalization to a recoverable job flow instead of a single fragile request.

Routes/jobs:

- `POST /api/elections/:election_id/finalize`
- `finalization_jobs` worker

Tasks:

- Acquire election lock.
- Record durable `finalizing` state before accepting any on-chain side effect.
- Recheck registration deadline and state.
- Validate the requested voting end time at finalize: enforce a configurable
  maximum voting duration (default 30 days) and require an explicit
  confirmation field to exceed it, since the configured period is immutable
  on-chain (AR-M7).
- Snapshot registered voters.
- Reject zero-voter finalization.
- Select a circom-compatible Poseidon implementation (e.g. `light-poseidon` or
  an iden3-parameterization crate) as an explicit decision record: the Rust
  Merkle leaf/node/root computation must be bit-identical to the
  circomlibjs/circom output or every proof becomes invalid (AR-H7).
- Compute Merkle root from the snapshot.
- Create a finalization job.
- Submit on-chain `configureElection`.
- Poll receipt.
- Sync DB state only after on-chain success.
- Record partial failures for retry.
- Renew/fence locks or verify lock ownership before state-changing writes.
- Revalidate the voter snapshot before syncing DB state after on-chain success.

Deliverables:

- Finalize route.
- Finalization worker.
- Retry-safe job model.
- Tests for DB/on-chain partial failure.

Verification gate:

- Registration fails while finalization is in progress.
- Finalize with a voting end time beyond the configured maximum duration is
  rejected unless explicitly confirmed.
- On-chain success with DB sync failure is recoverable.
- DB state does not advance when on-chain configuration fails.
- Late registrations cannot create a DB Merkle root that diverges from the
  configured on-chain root.
- Committed cross-language test vectors (fixed secrets -> leaf, root, path)
  produce identical values in circomlibjs and the Rust Poseidon/Merkle
  implementation.

Definition of done:

- Finalization is safe under retry, timeout, and concurrent registration
  attempts.

### Phase 13. Proof Ticket and Vote Submission

Objective:

Port the privacy-critical voting path with strict validation and replay
protection.

Routes:

- `POST /api/elections/:election_id/proof`
- `POST /api/elections/:election_id/submit`

Tasks:

- Issue single-use ticket bound to election and Merkle root. The ticket MUST
  NOT bind or learn the nullifier: under the post-audit privacy model the
  server must not learn a voter's nullifier at authenticated `/proof` time
  (AR-H5).
- Do not log or persist identity-to-ticket associations; treat the ticket as
  the operator-side linkability ceiling pending the Phase 18 unlinkable
  authorization decision (AR-M1).
- Mitigate timing linkage (AR-M2): add client-side random submission jitter
  within the ticket TTL, let the relayer queue (AR-M5) process submissions
  without preserving issuance order, and do not retain `/proof` issuance
  timestamps in logs beyond operational necessity. Residual correlation by a
  global passive observer is accepted for v1 and measured in Phase 18.
- Keep ticket expiry short.
- Use a ticket-scoped Redis lock or Lua script for read-validate-consume
  atomicity.
- Validate proof and public signal shapes.
- Validate public `election_id` against route, ticket, DB, and contract
  election identity.
- Validate candidate index range.
- Validate public root against finalized election root.
- Validate nullifier uniqueness against contract state (and durable submission
  records); the ticket no longer carries a nullifier to compare against.
- Use contract preflight before relaying.
- Serialize relayer transaction sends behind a per-wallet queue or lock
  (`tx.wait()` outside the serialized window) so concurrent submissions from
  distinct voters cannot collide on nonces (AR-M5).
- Reconcile front-run submissions: when the relayed transaction reverts with a
  duplicate-nullifier error, re-check `usedNullifiers` on-chain and report
  success-by-other-transaction instead of a failure (AR-L8).
- Persist vote submission status and transaction hash.
- Ensure failed relayer submission does not consume durable vote state
  incorrectly.
- Ensure frontend submit failures clear loading state and surface actionable
  error details.

Deliverables:

- Proof route.
- Submit route.
- Submission ticket repository/service.
- Vote submission service.
- Route-level tests for malformed proof, malformed public signals, mismatch,
  duplicate nullifier, expired ticket, and candidate overflow.

Verification gate:

- Ticket reuse is rejected.
- Election mismatch is rejected.
- Root mismatch is rejected.
- A nullifier already used on-chain is rejected (no ticket-nullifier binding
  exists to mismatch).
- Duplicate nullifier is rejected before relayer transaction.
- Concurrent submissions from distinct voters do not produce relayer nonce
  collisions.
- A vote landed by a third party copying the relayer's mempool transaction is
  reconciled as success, not reported as failure.
- Ticket is not lost on preflight failures that should be user-retryable.
- Backend never requires JWT on anonymous submit.

Definition of done:

- The Rust voting path is at least as safe as the hardened Node path and keeps
  anonymous submit semantics under the post-audit privacy model.

### Phase 14. Completion and Results

Objective:

Port election completion and final result exposure.

Routes:

- `POST /api/elections/:election_id/complete`
- `GET /api/elections/completed` (already ported read-only in Phase 7; here only
  re-verify its result shape after completion writes — do not re-port)

Tasks:

- Reject completion before `voting_end_time`.
- Read on-chain tally or trusted submission-derived tally according to the
  finalized product decision.
- Persist completed state once.
- Make completed results frontend-compatible.
- Define what happens if chain reads fail after voting end.

Deliverables:

- Completion route.
- Results read model.
- Tests for before-end rejection and idempotent completion.

Verification gate:

- Completion before voting end returns 4xx.
- Completion after voting end succeeds only from valid active/ended states.
- Completed election appears in completed list with expected result shape.

Definition of done:

- The full admin and voter lifecycle can reach completed state in Rust.

### Phase 15. Frontend Integration

Objective:

Switch frontend API calls gradually without changing the user-facing flow.

Tasks:

- Add API base URL environment flag.
- Keep Supabase login unchanged.
- Replace the frontend's direct Supabase `Admins` table reads
  (`frontend/src/App.js`) with a backend role endpoint (e.g. `GET /api/me`
  returning `is_admin`) served by the active backend, so admin gating survives
  the Cloud SQL migration (AR-H4).
- Convert all `datetime-local` values to ISO strings before submit.
- Switch read-only routes first.
- Switch write routes by lifecycle stage.
- Keep Node fallback available until Rust E2E staging passes.
- Add browser smoke tests for admin and voter flows.

Deliverables:

- Frontend API client configuration.
- Route-by-route switch plan.
- Browser smoke test checklist.

Verification gate:

- Admin can create and finalize election through Rust-backed routes.
- Voter can register, generate proof, and submit vote through Rust-backed
  routes.
- Frontend role routing matches active-backend authorization for the same
  user without any direct Supabase table read.
- Frontend still works when pointed to Node during rollback.

Definition of done:

- Frontend can target Rust in staging without route shape breakage.

### Phase 16. Staging Deployment

Objective:

Deploy the Rust backend and connect it to the prepared GCP staging resources.
This phase cannot begin until Phase 1 has no open Critical or High audit item.

Tasks:

- Build container image for Rust API.
- Push image to Artifact Registry.
- Deploy Cloud Run service.
- Attach Cloud SQL connection.
- Attach VPC connector for Redis private IP access.
- Mount Secret Manager values as environment variables.
- Grant only required IAM roles to the runtime service account.
- Grant Secret Manager access only on required `zkvote-staging-*` secrets.
- Configure CORS for staging frontend.
- Ensure legacy AWS EC2/S3/CloudFront auto-deploy is gated or disabled before
  merging staging-bound changes.

Deliverables:

- Cloud Run service.
- Deployment script or CI workflow.
- Staging runtime configuration.

Verification gate:

- `/healthz` returns 200 from Cloud Run.
- `/readyz` returns 200 from Cloud Run.
- Cloud Run can connect to Cloud SQL.
- Cloud Run can connect to Memorystore Redis through VPC connector.
- Cloud Run can read required secrets.
- Runtime service account can read/write only the zk-vote artifact bucket.
- Runtime service account cannot read unrelated project secrets.
- No main-push workflow can deploy unfinished migration work to live AWS
  infrastructure without approval.

Definition of done:

- Staging backend is reachable and connected to all required managed services.

### Phase 17. CI/CD and Quality Gates

Objective:

Make regressions visible before deployment.

Tasks:

- Add Rust format, clippy, and test jobs.
- Add Node helper and route tests while Node remains active.
- Add Hardhat contract tests.
- Add MockVerifier tests for successful submit, duplicate nullifier,
  wrong-election public signal, wrong root, and candidate overflow.
- Add circuit artifact/schema checks for public signal length and ordering.
- Add migration verification job.
- Add frontend build job.
- Add optional staging deploy job gated by environment approval.
- Gate or disable legacy AWS deploy workflows during migration.
- Switch all CI and deploy installs to `npm ci` against committed lockfiles;
  remove bare `npm install` from deploy workflows, including the on-host EC2
  step (AR-H8).
- Add dependency-audit jobs (`npm audit` or osv-scanner; `cargo audit` or
  `cargo deny`) as required checks; pin exact versions for proving-critical
  packages (`snarkjs`, `circomlibjs`, `circomlib`) and treat their upgrades as
  reviewed changes that re-run the circuit regression suite (AR-H8).
- Decide which generated artifacts should be committed.

Deliverables:

- GitHub Actions workflows or equivalent CI config.
- Required check list.
- Artifact commit policy.

Verification gate:

```bash
node --check server/index.js
npx hardhat test --no-compile
cd rust-backend && cargo fmt --check
cd rust-backend && cargo test --workspace
cd rust-backend && cargo clippy --workspace -- -D warnings
cd frontend && npm run build
```

Additional audit regression checks:

- C1/H1 tests fail against the old circuit/contract boundary and pass against
  the fixed one.
- `/proof` response tests assert that plaintext `user_secret` is absent.
- Submit route tests cover ticket replay, mismatch, and preflight failure
  without accidental durable state corruption.
- CI refuses ungated live AWS deployment from main during the migration window.
- CI fails when a deploy path bypasses the committed lockfile or an unpinned
  proving-critical dependency version is introduced.

Definition of done:

- A pull request cannot silently break backend syntax, Rust checks, contract
  tests, or frontend build.

### Phase 18. Security Re-audit and Privacy Review

Objective:

Re-run the security review after Phase 1 and the Rust route migrations are
implemented, and confirm that no audit blocker was reintroduced.

Tasks:

- Reconcile every item in `audit.md`:
  - closed with code/test evidence;
  - intentionally accepted with documented rationale; or
  - still open and blocking production.
- Document trust boundaries:
  - frontend proof generation
  - backend ticket issuance
  - Redis ticket storage
  - relayer transaction submission
  - chain verification
  - artifact generation and storage
- Review whether nullifier, root, and candidate public signals leak acceptable
  information.
- Measure ticket-issuance-to-on-chain timing correlation in staging, decide
  whether unlinkable authorization (blind-signed tokens / anonymous
  credentials) replaces the bearer ticket, and define the minimum anonymity
  set / turnout threshold below which results must not be presented as
  privacy-preserving (AR-M1/AR-M2).
- Record the accepted v1 on-chain visibility properties in the threat model:
  running tallies and per-vote candidate choices are publicly readable during
  voting, and a voter holding their secret can prove how they voted
  (receipt-ability / vote-buying exposure) (AR-L3).
- Review admin privilege scope.
- Review Secret Manager access.
- Review bucket IAM.
- Review replay and double-vote protections.
- Review finalization race and partial failure behavior.
- Review whether the final client-held-secret design preserves privacy against
  backend operators.
- Review whether deployed artifacts match stored manifest hashes.

Deliverables:

- `docs/SECURITY_REVIEW.md`.
- Threat model.
- Pre-production risk register.
- Audit closure matrix for C1-H5 and M1-M13.

Verification gate:

- No relayer private key appears in committed files.
- No DB password appears in committed files.
- Artifact bucket IAM is bucket-scoped.
- Submit path has tests for replay and mismatch cases.
- C1/H1/H2 regression tests are present and failing versions are understood.
- Finalization partial-failure tests are present.

Definition of done:

- The team has a written, route-level security position and audit-closure proof
  for the first production candidate.

### Phase 19. Migration Cutover

Objective:

Move from Node active backend to Rust active backend with rollback.

Tasks:

- Freeze Node API changes except critical fixes.
- Execute the live-data migration: a one-time ETL exporting hosted-Supabase
  rows (`Elections`/`Voters`/`Admins`/`AdminInvitations`) into the Cloud SQL
  schema, with row-count and checksum verification (AR-H3).
- Define the cutover data strategy: a write-freeze window or dual-write
  period, and an explicit data-rollback path covering rows written by Rust if
  operation rolls back to Node (AR-H3).
- Run Node and Rust side by side in staging.
- Compare responses for compatibility routes.
- Switch frontend read routes to Rust.
- Switch admin write routes to Rust.
- Switch registration/finalization to Rust.
- Switch proof/submit to Rust last.
- Keep Node deployable until Rust has completed at least one full staging
  election lifecycle.

Deliverables:

- Cutover checklist.
- Rollback checklist.
- Data migration script and verification report.
- Side-by-side route comparison results.

Verification gate:

- One full staging election completes on Rust:
  - create
  - artifact setup
  - allowlist
  - voter registration
  - finalization
  - proof generation
  - vote submission
  - completion
  - result display
- Migrated row counts and checksums match between the source Supabase tables
  and the Cloud SQL tables at cutover.
- A rollback rehearsal restores Node operation without data loss.

Definition of done:

- Rust becomes the active backend only after a full staging E2E proof, and Node
  remains available for rollback until production confidence is established.

### Phase 20. Production Readiness

Objective:

Prepare production separately from staging instead of upgrading staging in
place.

Tasks:

- Create production GCP resources with separate names and secrets.
- Upgrade Cloud SQL tier and consider HA.
- Define backup and restore policy.
- Define Redis persistence and failure behavior.
- Configure domain, TLS, CORS, and monitoring.
- Add alerting for DB, Redis, Cloud Run, relayer failures, and job backlog.
- Run load and concurrency tests for registration/finalization/submit.

Deliverables:

- Production infrastructure plan.
- Backup/restore runbook.
- Incident runbook.
- Monitoring dashboard.

Verification gate:

- Restore test succeeds.
- Staging load test meets expected capacity.
- Production secrets are separate from staging.

Definition of done:

- The system can be operated and recovered, not merely deployed.

## 6. E2E Milestones

### Milestone A. Local Rust Foundation

Includes phases 0-4.

Exit criteria:

- Audit blocker rebaseline is complete enough to permit Rust work to claim
  staging readiness later.
- Local Postgres and Redis are reproducible.
- Rust API health/readiness is stable.
- Core config, error, tracing, and module structure are ready.

### Milestone B. Rust Read Parity

Includes phases 5-7.

Exit criteria:

- Supabase JWT validation works.
- Read-only election APIs match frontend expectations.
- Frontend can read from Rust behind a flag.

### Milestone C. Admin Lifecycle Parity

Includes phases 8-12.

Exit criteria:

- Admin can create, configure, allowlist, register, and finalize an election in
  Rust.
- Finalization is recoverable and race-safe.

### Milestone D. Private Vote Submission Parity

Includes phase 13.

Exit criteria:

- Ticket/proof/submit path is anonymous under the post-audit privacy model:
  tickets are single-use, root-bound, and election-bound; the server never
  learns a voter's nullifier before submit; and every accepted vote is
  contract-verified with on-chain nullifier uniqueness.

### Milestone E. Full Staging E2E

Includes phases 14-19.

Exit criteria:

- Full election lifecycle passes in GCP staging through the React frontend and
  Rust backend.
- No Critical or High audit item remains open.

### Milestone F. Production Candidate

Includes phase 20.

Exit criteria:

- Production infra, monitoring, backups, security review, and rollback plan are
  complete.

## 7. Suggested Immediate Next Work

1. Promote `audit.md` to `docs/SECURITY_REVIEW.md` or explicitly keep it as the
   temporary canonical security review.
2. Implement circuit/contract v2 for C1/H1: public `election_id`, boolean
   `pathIndices`, regenerated artifacts, `uint[4]` verifier boundary, and
   backend/frontend public-signal updates.
3. Redesign registration/proof privacy for H2: client-held voter secret,
   backend commitment/leaf storage only, and no plaintext secret in `/proof`.
4. Add MockVerifier and route-level regression tests that would catch C1/H1/H2.
5. Harden deployment/finalization/ticket flows for H3/H4/M1/M12 before any
   staging claim.
6. Fix staging/deployment hygiene from M2/M9/M10/M11: `.ptau`/`circom`,
   secret-scoped IAM, DB password secret ordering, and AWS CD gating.
7. Resume Rust route parity only after the security rebaseline has a clear
   pass/fail status.

## 8. Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| C1 election ID is private in circuit | Registered voter can mint multiple valid nullifiers and overvote | Circuit public `election_id`, contract check, regenerated verifier/artifacts, regression tests |
| H1 Merkle `pathIndices` unconstrained | Registered voter with a valid path can forge membership for arbitrary leaves | Boolean constraints for each path index and verifier regression tests |
| H2 backend-held voter secret | Backend/operator can deanonymize votes and forge secrets if salt leaks | Client-held secret, backend commitment-only storage, `/proof` never returns secret |
| H3/H4 deployment/finalization races | Election can become unrecoverable or exclude late registrations silently | Durable deployment/finalizing states, lock fencing/renewal, artifact hash binding, retryable workers |
| H5 admin invitations never consumed | Invited future admins are never granted access; silent provisioning failure | Invitation acceptance/auth-time promotion from `AdminInvitations`, visible failure on promotion error |
| Rust route response drift from Node | Frontend breaks during cutover | Compatibility matrix and route tests |
| Finalization partial failure | Registration or voting state becomes inconsistent | Job model, locks, retry-safe DB state |
| Ticket replay or premature consume | Double relay attempt or vote UX loss after transient failure | Ticket-scoped lock/Lua consume, mismatch tests, frontend failure handling |
| ZK artifact mismatch | Invalid verifier/proof pairing or deployed election proof breakage | Manifest, sha256, required artifact validation, election-artifact binding |
| Relayer key exposure | Chain account compromise | Secret Manager, local `.env`, no committed secrets |
| Overbroad GCP secret access | Runtime service account can read unrelated project secrets | Secret-level IAM bindings for `zkvote-staging-*` only |
| Live AWS auto-deploy during migration | Dirty or incomplete migration work reaches EC2/S3/CloudFront | Gate workflows with manual approval/environment protection or disable legacy CD |
| Redis outage | Locks/tickets unavailable | Readiness checks and explicit degraded behavior |
| Cloud SQL cost growth | Staging cost surprise | Low-cost staging tier, separate prod sizing |
| Noir POC confusion | Production ZK path drift | Keep Noir isolated from production artifact selection |

## 9. Completion Definition for the Whole Project

The project is not complete when the Rust server simply compiles. It is complete
for the first production candidate only when:

- Admin and voter flows pass end-to-end in staging through the frontend.
- All Critical and High audit findings are closed or explicitly reclassified
  with code-backed evidence.
- Staging blockers from Medium audit findings have been fixed or are tracked as
  intentional non-production limitations.
- Rust backend owns all required production routes.
- Node backend is no longer required for normal operation.
- ZK artifacts are versioned, integrity-checked, and stored outside source-only
  paths.
- The production circuit exposes and verifies election identity, constrains
  Merkle path indices, and uses the post-audit public signal order everywhere.
- Voter secrets are not generated, stored, or returned by the backend.
- Contracts are deployed or linked through reproducible tooling.
- Submission replay, mismatch, and duplicate nullifier cases are tested.
- Finalization is recoverable after partial DB or chain failures.
- Production infrastructure is separate from staging.
- Secrets, IAM, backup, monitoring, and rollback plans are documented and
  verified.
