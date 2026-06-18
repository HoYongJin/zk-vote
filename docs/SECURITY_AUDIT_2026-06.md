# Security Audit — Adversarial Pass (2026-06-19)

Adversarial security audit of the full zk-vote system (Solidity + Circom trust anchor,
Rust backend, live Node backend, frontend, infra/CI) conducted as the production-readiness
gate. 13 attack surfaces were swept; every finding was independently verified by skeptics
(exploitability / mitigation / correctness lenses) to remove false positives.

**Result:** 25 non-Info findings → 22 survived verification (2 High, 4 Medium, 16 Low),
3 refuted, 7 Info. Baseline was confirmed green before remediation.

Status legend: ✅ Fixed · 🛡️ Mitigated/hardened · 📄 Accepted+documented · ⏳ Deferred (reason)

## High

| ID | Title | Status |
|---|---|---|
| INFRA-1 | `.gcloudignore` omits `.env` → secrets uploaded to Cloud Build source bucket on `gcloud builds submit .` | ✅ |
| SOL-VERIF-1 | Stale `uint[3]`/`uint[2]` verifiers name-resolvable by deploy scripts → can brick an election (uint[4] tally → uint[3] verifier = always-revert `submitTally`) | ✅ |

## Medium

| ID | Title | Status |
|---|---|---|
| RUST-AUTH-1 | Unauthenticated JWKS-refresh amplification DoS via attacker-chosen unknown `kid` | ✅ |
| RUST-AUTH-2 | Admin auto-promotion keyed on **unverified** JWT `email` claim (privilege escalation) — re-rated Medium | ✅ |
| SOL-VERIF-2 | CI artifact-schema gate only checks the 2 good verifiers; doesn't fail on `uint[3]` verifier presence | ✅ |
| CHAIN-1 | Revert-vs-transport classification by fragile substring match of RPC error strings | ✅ |

## Low

| ID | Title | Status |
|---|---|---|
| CHAIN-2 / SOL-INFO-4 | Transport error after `send()` burns ticket without nullifier recheck (recovered by upfront check; UX) | ✅ |
| SOL-VAL-3 | Groth16 proof points validated against scalar field Fr instead of base field Fq → rare valid proofs rejected | ✅ |
| RUST-AUTH-3 (Info) | JWKS validation algorithm not pinned (alg-confusion defense) | 🛡️ already mitigated: algorithm is bound per-JWK key and enforced by Validation::new(algorithm), so HS/RS confusion is rejected |
| CIRCOM-1 | Legacy unsound `VoteCheck_3.circom` sits beside the live circuit | ✅ |
| SQL-1 | `ALTER DEFAULT PRIVILEGES` grants UPDATE on future tables → breaks append-only intent | ✅ |
| NODE-2 | On-chain/ethers error reasons reflected verbatim to anonymous `/submit` clients (info leak) | ✅ |
| NODE-1 | Live Node `/proof`+`/submit` have no IP/identity rate limit (declared dep unused) | 🛡️ |
| INFRA-2 | `REQUIRE_BEACON=true` inert on Cloud Run (Rust never reads it) → false assurance | ✅ |
| FE-3 | Voter secret in localStorage persists past vote/logout (XSS window) | ✅ |
| SOL-MGMT-1 | `setZkDeploy` deploys verifier bytecode without binding to the registered artifact sha256 | 🛡️ |
| CHAIN-4 | No gas-limit / fee cap on relayer txs (griefing / stuck-tx) | ⏳ staging tuning |
| CHAIN-3 | No confirmation depth / reorg handling (recorded confirmed at 0 conf) | 📄 v1 |
| SQL-2 | Two-role least-privilege not exercised when migrations/app run as superuser locally | 📄 staging uses 2-role |
| SOL-DOS-2 | `relay_lock` held through receipt-wait self-throttles votes | 📄 v1 (split deferred to staging) |
| FE-1 | Artifact integrity manifest fetched from the same API it validates (no independent anchor) | 📄 transport-only by design |
| XCUT-3 | No durable reconciler for stuck `FINALIZATION_DB_SYNC_FAILED`/`SNAPSHOT_CHANGED` states | 📄 manual runbook (workers crate stub) |

## Discovered during final verification

| ID | Title | Status |
|---|---|---|
| VERIFY-1 | `vote_pipeline` E2E was ~50% flaky (random leaf ordering); masked a need to confirm Merkle correctness | ✅ test made deterministic; **`merkle.rs` independently verified bit-exact** with the circuit/JS root (no production bug) |
| XCUT-4 (Medium, cutover) | Both Node and Rust build the Merkle tree from `voters ... ORDER BY id`. The Phase-19 Supabase→Postgres ETL **MUST preserve voter `id` values** — if it reassigns them, the leaf order (hence the Merkle root and every registered voter's path) changes and all in-flight proofs break on cutover. | 📄 documented — verify before running ETL (`scripts/migration/etl-supabase-to-postgres.js` must carry `voters.id`); this is a hard cutover invariant |

## Refuted by verification (not real)

- SOL-DOS-1 (anon `/submit` cost-exhaustion DoS) — infra/LB-level rate limiting is the right layer.
- FE-2 (pre-manifest fallback proves with unverified artifacts) — fallback path is gated.
- XCUT-1 (operator links voter→vote beyond passive-observer risk) — within the documented accepted v1 risk.

## Info (noted, low-value)

SOL-2 (`electionId==0` not rejected — inert), RUST-AUTH-3 (alg pin — fixed above),
SOL-INFO-4 (ticket burn — fixed via CHAIN-2), SQL-3 (UPDATE grant on integrity columns —
related to SQL-1), NODE-3 (fail-open on some Redis/supersede reads, guarded by the Postgres
`merkle_root` invariant), XCUT-2 (vestigial `setMerkleRoot`/`setVotingPeriod` owner surface —
inert, owner-only; left unchanged to avoid modifying the audited trust-anchor contract pre-deploy).

---

*Remediation commits follow this file; each fix is a separate verified work unit. Accepted/
deferred items are tracked here with their rationale so they are not silently dropped.*
