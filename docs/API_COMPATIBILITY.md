# zk-vote API Compatibility Matrix

This document captures the current Node/Express API surface that the Rust
backend must preserve or intentionally replace with a documented migration.

> **Contract revision: v2 (post-audit, 2026-06-12).** This matrix documents the
> Phase-1-fixed boundary: 4-element `publicSignals` including `electionId`
> (C1/H1 circuit v2), client-held voter secrets with commitment-based
> registration, and a `/proof` response that never returns a plaintext secret
> (H2). Rust parity work must target THIS revision; the pre-audit v1 shapes
> (3-signal submit, server-derived `user_secret`) are no longer valid
> (architecture review AR-L1).

Base path:

```text
/api
```

## Auth Modes

| Mode | Meaning |
| --- | --- |
| Admin | Requires Supabase JWT and a matching row in `Admins.id`. |
| User | Requires Supabase JWT for any authenticated user. |
| Anonymous ticket | Does not require JWT; requires a single-use Redis submission ticket issued by `/proof`. |

## Routes

| Route | Method | Auth | Current owner | Rust parity priority |
| --- | --- | --- | --- | --- |
| `/management/addAdmins` | POST | Admin | `server/routes/addAdmins.js` | Medium |
| `/elections/set` | POST | Admin | `server/routes/setVote.js` | High |
| `/elections/registerable` | GET | User | `server/routes/registerableVote.js` | First read parity |
| `/elections/finalized` | GET | User | `server/routes/finalizedVote.js` | First read parity |
| `/elections/completed` | GET | User | `server/routes/completedVote.js` | First read parity |
| `/elections/:election_id/setZkDeploy` | POST | Admin | `server/routes/setupAndDeploy.js` | High |
| `/elections/:election_id/voters` | POST | Admin | `server/routes/registerByAdmin.js` | High |
| `/elections/:election_id/register` | POST | User | `server/routes/register.js` | High |
| `/elections/:election_id/finalize` | POST | Admin | `server/routes/finalizeVote.js` | Critical |
| `/elections/:election_id/proof` | POST | User | `server/routes/proof.js` | Critical |
| `/elections/:election_id/submit` | POST | Anonymous ticket | `server/routes/submitZk.js` | Critical |
| `/elections/:election_id/complete` | POST | Admin | `server/routes/completeVote.js` | High |
| `/zkp-files/*` | GET (static) | Public / none | `server/index.js:42` (`express.static('zkp')`) | Medium |

> `/api/zkp-files/*` is a static file mount, not a JSON route handler. It serves
> the client-side proving artifacts (`build_<d>_<c>/*.wasm`, `circuit_final.zkey`).
> It currently exposes the entire `server/zkp` directory (including `setUpZk.sh`,
> `.circom` sources, and the pre-contribution `circuit_0000.zkey`); per the audit
> it should be scope-narrowed to `build_*/` artifacts. Note that public exposure
> of `.wasm`/`.zkey` is also part of the C1 attack surface (a forged-proof
> attacker can prove offline), which is mitigated by the C1/H1 circuit fix, not by
> hiding these files.

## Field Compatibility

The active frontend and Node backend use these database/API names:

| Concept | Current API field |
| --- | --- |
| Election title | `name` |
| Registration start | `registration_start_time` |
| Registration end | `registration_end_time` |
| Voting start | `voting_start_time` |
| Voting end | `voting_end_time` |
| Completed flag | `completed` |
| Voting contract | `contract_address` |
| Verifier contract | `verifier_address` when available |
| Voter leaf commitment (Circom flow) | `secretCommitment` in the register request; stored in the legacy `user_secret` DB column as `H(secret)`; never returned by any route |

Rust may introduce stricter internal names, but public route responses must
continue to expose the current frontend-compatible names until the frontend is
explicitly migrated. Note: the plaintext voter secret is client-held (H2); the
`user_secret` column name survives only as legacy storage for the commitment.

## Route Details

### `POST /api/management/addAdmins`

Request:

```json
{ "email": "admin@example.com" }
```

Behavior:

- Normalizes and validates email.
- Upserts into `AdminInvitations`.
- Does not itself grant admin rights; runtime admin checks still read `Admins`.

Rust notes:

- Preserve idempotent upsert behavior.
- Document or implement the invitation-to-admin acceptance path before relying
  on this as a full admin provisioning flow.

### `POST /api/elections/set`

Request:

```json
{
  "name": "Election name",
  "merkleTreeDepth": 10,
  "candidates": ["A", "B"],
  "regEndTime": "2026-06-11T12:00:00.000Z"
}
```

Success:

```json
{
  "success": true,
  "message": "New election record created successfully.",
  "election": {}
}
```

Rust notes:

- Keep ISO UTC input.
- Keep candidate trim behavior.
- Enforce Merkle depth `1..20`, with frontend currently using `2..20`.

### `GET /api/elections/registerable`

Response:

```json
[
  {
    "id": "uuid",
    "name": "Election name",
    "candidates": ["A", "B"],
    "contract_address": "0x...",
    "registration_end_time": "2026-06-11T12:00:00.000Z",
    "isRegistered": false
  }
]
```

Behavior:

- Admin sees all elections whose registration window is active.
- Non-admin sees only elections where their normalized email is allowlisted.
- Non-admin rows include `isRegistered`.

### `GET /api/elections/finalized`

Response:

```json
[
  {
    "id": "uuid",
    "name": "Election name",
    "candidates": ["A", "B"],
    "voting_end_time": "2026-06-11T12:00:00.000Z",
    "contract_address": "0x...",
    "merkle_tree_depth": 10,
    "num_candidates": 2,
    "total_voters": 10,
    "registered_voters": 8
  }
]
```

Behavior:

- Admin gets all active voting elections plus voter counts.
- Non-admin gets only elections where they completed registration.

### `GET /api/elections/completed`

Response:

```json
[
  {
    "id": "uuid",
    "name": "Election name",
    "candidates": ["A", "B"],
    "voting_end_time": "2026-06-11T12:00:00.000Z",
    "contract_address": "0x..."
  }
]
```

Behavior:

- Admin sees all completed elections.
- Non-admin sees completed elections where they completed registration.

### `POST /api/elections/:election_id/setZkDeploy`

Behavior:

- Loads election depth and candidate count.
- Requires no existing `contract_address`.
- Requires Circom library files.
- Ensures required ZK artifacts exist:
  - Solidity verifier
  - wasm
  - zkey
  - verification key
- Runs ZK setup if artifacts are missing.
- Runs Hardhat deployment script.

Rust notes:

- Replace shell execution with an artifact/deployment job before production.

### `POST /api/elections/:election_id/voters`

Request:

```json
{ "emails": ["voter@example.com"] }
```

Behavior:

- Admin only.
- Normalizes emails.
- Rejects registration after deadline or finalization marker.
- Inserts new allowlist rows and reports duplicate/invalid counts.

### `POST /api/elections/:election_id/register`

Request:

```json
{
  "name": "Voter name",
  "secretCommitment": "12345678901234567890"
}
```

Behavior:

- User only.
- User email must match an allowlisted voter row.
- `secretCommitment` is the client-computed Poseidon `H(secret)` as a decimal
  or `0x`-hex field-element string; the client generates and keeps the
  plaintext secret (H2). Invalid commitment returns 400 `VALIDATION_ERROR`.
- Stores only the commitment (legacy `user_secret` column); the server never
  derives, stores, or returns the plaintext secret.
- Updates voter row under election Merkle lock.
- Rechecks registration deadline and finalization state inside the lock.

### `POST /api/elections/:election_id/finalize`

Request:

```json
{ "voteEndTime": "2026-06-11T12:00:00.000Z" }
```

Behavior:

- Admin only.
- Requires deployed contract.
- Requires non-empty registered voter set.
- Computes final Merkle root under election lock.
- Calls `VotingTally.configureElection`.
- Updates DB only after on-chain success.
- Stores Redis marker when on-chain config succeeds.

Rust notes:

- Convert this to a retry-safe `finalization_jobs` worker.

### `POST /api/elections/:election_id/proof`

Behavior:

- User only. No request body.
- Requires active voting window.
- Requires finalized DB Merkle root.
- Loads the registered voter's stored leaf commitment `H(secret)`.
- Generates Merkle proof.
- Verifies proof root matches DB root.
- Issues submission ticket bound to election and root only. The ticket MUST
  NOT bind a nullifier: the server never learns the voter's nullifier before
  submit (post-H2 privacy model, AR-H5).

Response (v2 — no plaintext secret):

```json
{
  "success": true,
  "message": "Merkle proof generated successfully.",
  "submissionTicket": "uuid",
  "root": "123",
  "pathElements": [],
  "pathIndices": []
}
```

The client combines this with its locally held secret to build circuit inputs;
`user_secret` is never present in the response.

### `POST /api/elections/:election_id/submit`

Request:

```json
{
  "formattedProof": {
    "a": ["1", "2"],
    "b": [["1", "2"], ["3", "4"]],
    "c": ["1", "2"]
  },
  "publicSignals": ["root", "candidateIndex", "nullifierHash", "electionId"],
  "submissionTicket": "uuid"
}
```

`publicSignals` is the verbatim snarkjs output of the v2 circuit, in this
fixed order: `[root, candidateIndex, nullifierHash, electionId]` (`nPublic`
= 4). `electionId` is `BigInt("0x" + election uuid without dashes)` as a
decimal string.

Behavior:

- Anonymous by design.
- Rejects `publicSignals` whose length is not exactly 4 with 400
  `INVALID_PAYLOAD` (the v1 3-signal shape is no longer accepted).
- Rejects missing, expired, reused, or malformed ticket.
- Rejects ticket election mismatch.
- Rejects an `electionId` public signal that does not match the route's
  election with 400 `ELECTION_ID_MISMATCH` (C1 fix; the contract enforces the
  same binding on-chain).
- Rejects root mismatch.
- Rejects candidate overflow.
- Checks used nullifier on contract before relaying (the ticket carries no
  nullifier to compare against).
- Uses `callStatic.submitTally` before submitting transaction.

### `POST /api/elections/:election_id/complete`

Behavior:

- Admin only.
- Rejects missing voting end time.
- Rejects completion before `voting_end_time`.
- Marks `completed=true` once.

Rust notes:

- Future implementation should read final tally from chain or a documented
  trusted source before exposing completed results.
