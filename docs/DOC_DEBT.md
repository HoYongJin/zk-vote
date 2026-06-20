# Documentation Debt Ledger

A PM-level audit (2026-06-19) of every subsystem found the documentation lagging the code —
unsurprising, since all 20 phases landed on one feature branch with a large uncommitted
working tree. This ledger tracks every known discrepancy with its exact fix.

**Why this exists instead of just editing the docs:** most flagged docs (`AGENT.md`,
`audit.md`, and all `docs/*.md` except `PRODUCTION_READINESS.md`) are **dirty in the working
tree** — coherent prior-agent WIP that must be preserved. To avoid muddying that WIP, only
**clean** docs and the **agent-governing `AGENT.md`** were corrected now; the rest should be
applied **after the WIP is committed**, ideally in one "doc reconciliation" commit.

Status: ✅ done · ⏳ pending (apply after WIP commit) · 🔧 needs a code change (out of scope this session) · ❓ needs a decision

---

## ✅ Applied now (clean / governance-critical)

| File | Fix |
|---|---|
| ✅ `README.md` | Replaced "Rust backend migration scaffold" framing with the true status (full route parity; Node live until staging+cutover executed); added a frontend-hosting note. |
| ✅ `AGENT.md` | Removed "newly scaffolded / initial scaffold … must not replace Node routes" framing; corrected "Current Rust API: /healthz /readyz" and the "Planned migration order" to reflect Phases 4–15 done; fixed the internally-inconsistent `/submit` nullifier invariant bullet. |
| ✅ `frontend/README.md` | Replaced default Create-React-App boilerplate with a real project README (env vars, route map, proof flow, client-held-secret model, hosting note). |

---

## ⏳ `audit.md` (dirty)

1. **Test-count mismatch** — header cites "81 passing"; `SECURITY_REVIEW.md` cites "79". Pick one authoritative number (re-run `npx hardhat test` after committing the WIP) or reference "see CI" instead of a hardcoded count.
2. **Stale rev4 verification table (~lines 280–292)** — still says "24 passing", "cargo test 2 passing", "circom 미설치", "nPublic=3 / verifier uint[3]". All false now (nPublic=4/uint[4], circom 2.2.3 installed, suite far larger). Add a "superseded — rev4 snapshot" banner like the one on the Conclusion, or move the table to a labelled historical appendix.

## ⏳ `docs/SECURITY_REVIEW.md` (dirty)

3. **"79 hardhat tests" → align to the matrix's "81"** (or the freshly re-run count).
4. **Frontend crypto = circomlibjs is wrong** — frontend uses **poseidon-lite 0.3.0**; circomlibjs remains only on the legacy Node server. Rephrase the bit-identity claim as poseidon-lite(frontend) ↔ circomlibjs(server) ↔ light-poseidon(Rust) ↔ circom.
5. **Pin the baseline** — add the branch/commit (`codex/phase1-c1-h1-circuit-contract-v2`) to section 1 so the closure matrix is self-contained.

## ⏳ `docs/ARCHITECTURE_REVIEW.md` (dirty)

6. **AR-H8 evidence** still cites frontend `"circomlibjs": "^0.1.7"` (caret) as a live finding — it has been removed/replaced by poseidon-lite 0.3.0 (exact). Update evidence.
7. **AR-H7 evidence** still says "0 crypto crates in rust-backend" — now false (`light-poseidon 0.2` in `Cargo.toml:35` + `crates/zkp`). Append a closure note (AR-H7 is marked CLOSED elsewhere).
8. **AR-L2** (audit closure matrix delivered) should be marked resolved, citing `SECURITY_REVIEW.md`, in both the AR-L table and the residual list.

## ⏳ `docs/DATA_MODEL.md` (dirty)

9. **`user_secret` column** — drop references to storing the commitment in the legacy `user_secret` column; the target schema stores `voters.user_secret_commitment` (`user_secret` is DROPPED by migration 0003). Keep a historical note.
10. **Append-only privilege detail** — note that `zk_artifacts` and `contract_deployments` are SELECT/INSERT only (no UPDATE), distinct from the other app tables; and that `ALTER DEFAULT PRIVILEGES` would grant UPDATE on future tables (append-only intent not auto-preserved).
11. **Document the `merkle_tree_depth` 1..20 CHECK** where schema decisions live.
12. **`vote_submissions` full shape** — note `status` CHECK {pending,submitted,confirmed,failed} + `tx_hash` + `error_message` for ETL authors.
13. **Public-signal order rule** — pin that snarkjs orders outputs before declared public inputs ⇒ `election_id` is index 3; future signal additions must not silently shift `VotingTally`'s index constants.

## ⏳ `docs/API_COMPATIBILITY.md` (dirty)

14. **`user_secret` → `user_secret_commitment`** (same as #9).
15. **Add `GET /healthz` and `GET /readyz` rows** (or a note that probes are out of parity-matrix scope) so infra doesn't assume there is no health probe.
16. **`addAdmins` semantics** — document that the Rust port only records an invitation; promotion is **lazy** on the invited user's next `/api/me`/admin request (`promotedExistingUser` hard-coded false; no Supabase Admin API, AR-L4).
17. **Document ethers v5 → alloy mapping** for the chain calls the Rust port replicates (`configured()`, `merkleRoot()`, `configureElection()`, `usedNullifiers()`, `callStatic.submitTally` → `staticCall`, …).

## ⏳ `docs/PROJECT_PLAN.md` (dirty)

18. **Section 7 "Suggested Immediate Next Work" is entirely done** — replace with the real next work: Phase 16 staging deploy (needs GCP cost approval) → Phase 18 residual measurements (AR-M1/AR-M2 timing, AR-H1 public beacon) → Phase 19 live ETL + rollback rehearsal + single-election E2E → Phase 20.
19. **Phase 11 supersede wording** vs the WIP redesign (replacement **election row**, superseded row immutable) — reconcile when the WIP commits.
20. **Migration 0002 status** — add a line that 0002 is retained-but-superseded by 0003 (or scheduled for squash).
21. **Frontend hosting** — record the decision (see ❓ below) so post-cutover hosting isn't silently AWS.

## ⏳ `docs/IMPLEMENTATION_GOALS.md` (dirty)

22. Header still frames the work as "Phase 1 잔여" though Phase 1 is closed and the program is at Phase 16+. Update the framing.

## ⏳ `docs/RUNBOOK_CUTOVER.md` / `docs/RUNBOOK_SUPERSEDE.md` (dirty)

23. **Cutover rollback** references an inverse ETL that doesn't exist — commit a reverse script or mark it a manual procedure (see ❓ #4 in TECH_STACK).
24. **Supersede runbook** — confirm it describes the new-row model end-to-end (no leftover "clear contract_address/verifier_address" steps) to match migration 0004.
25. **Staging API auth posture** — state the service is `--allow-unauthenticated` (auth enforced in-app via Supabase JWT) and that `OWNER_PRIVATE_KEY` is always mounted (must differ from relayer key).

## ⏳ `AGENT.md` — remaining (beyond what was applied)

26. **GCP Staging section** — document `scripts/gcp/deploy-staging-api.sh` (the actual Cloud Run deploy) and its inputs (`CONFIRM_COSTS=yes`, `CORS_ALLOWED_ORIGINS`, `OWNER_PRIVATE_KEY_SECRET`).
27. **List semantics** — `/registerable` excludes not-yet-open and superseded; `/finalized` excludes not-yet-started/ended/superseded and omits `total_voters`/`registered_voters` for voters.

---

## 🔧 Needs a code change (out of scope this "docs-only" session — track for later)

| # | Item | Action |
|---|---|---|
| 28 | Stale **`uint[3]` verifier `.sol` files** (`Groth16Verifier_3/_4_10/_6_10/_10_10/Groth16Verifier.sol`) are ABI-incompatible with `VotingTally`'s `uint[4]`; `deployAll.js` could name-resolve and deploy a broken pairing. | Delete/regenerate to `uint[4]`; extend `scripts/ci/check-artifact-schema.sh` to assert `uint[4]` across **all** `Groth16Verifier_*.sol`. |
| 29 | **`server/routes/secret.js`** is fully commented-out dead code (legacy secret-return endpoint). | ✅ RESOLVED (Phase 6.5 C3): `server/` deleted entirely. |
| 30 | **`frontend/src/setupProxy.js`** is commented out but references a dead EC2 IP + pre-REST routes; `http-proxy-middleware` dep unused. | ✅ RESOLVED (Phase 6.5 C4): `setupProxy.js` deleted. (Frontend now points at the Rust API via `REACT_APP_API_BASE_URL`.) |
| 31 | **Node `server/package.json` phantom deps** — `express-rate-limit`, `fs-extra`, `uuid` declared but unused. | ✅ RESOLVED (Phase 6.5 C3): `server/` (incl. its `package.json`) deleted. |
| 32 | **`CreateVotePage.js` merkle-depth placeholder** says "예: 10 (2^10)" but input `max=5` and artifacts only support depth 2–5. | Change placeholder to a valid in-range example. |
| 33 | **`deploy-staging-api.sh`** sets `REQUIRE_BEACON`/`APP_ENV` that the Rust binary ignores (Node-only flags). | Remove from the Rust deploy env, or implement them in `config.rs`. |
| 34 | **No `rust-toolchain.toml`** — CI floats `stable`, container pins 1.96. | Add `rust-backend/rust-toolchain.toml` (1.96). |
| 35 | **`ignition/`** empty/vestigial. | Remove or document that deploys use plain Hardhat scripts. |
| 36 | **`zkp-files` static route scope** — Node exposed the whole `zk` dir; should be narrowed to `build_*/` (the Rust port already restricts to allowed artifacts). | ✅ RESOLVED (Phase 6.5 C3): the Node route was deleted; Rust `artifacts.rs` serves only allow-listed `build_*` artifacts. |

---

## ❓ Needs a decision (see `docs/TECH_STACK.md` §6)

- **Frontend hosting** post-cutover (AWS S3/CloudFront vs GCP). Gates the Cloud Run `CORS_ALLOWED_ORIGINS`.
- **AR-M1** blind-signature unlinkable authorization — adopt or accept (deferred to Phase 18 after staging measurement).
- **Reverse ETL** for rollback — automate or document as manual.
