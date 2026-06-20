# Runbook: Phase 18 GCP Staging Standup (cost-gated)

> **STATUS: pre-execution.** Nothing here runs without `CONFIRM_COSTS=yes` **and**
> explicit user approval. This runbook turns the cost-incurring standup into a single,
> ordered, idempotent, rehearsed sequence so the only remaining decision is "spend / don't
> spend". Detailed per-step corrections from the 2026-06-21 adversarial audit are folded in
> as they are confirmed (see `## Audit remediations`).

## 0. Decision gate (the user's call)

Two inputs only you (the operator) can provide:

1. **The concrete project id.** The contradiction is now **resolved to a dedicated project**
   (`PROJECT_PLAN §18` + `.firebaserc` already say dedicated; the scripts' shared-POC default was the
   outlier and has been changed — `zkvote-staging-setup.sh` / `deploy-staging-api.sh` now default
   `PROJECT_ID=zkvote-staging`, and `PRODUCTION_READINESS.md` was corrected). You still supply the
   real **globally-unique** id (e.g. `zkvote-staging-7f3a`) via `GCP_PROJECT_ID`, because GCP project
   ids are globally unique. **Load-bearing constraint:** that one id is the JWT audience, so
   **frontend Firebase project (`REACT_APP_FIREBASE_PROJECT_ID` / `.firebaserc`) == backend GCIP
   project == Cloud Run `PROJECT_ID`**, or `deploy-staging-api.sh`'s `audience=<PROJECT_ID>` rejects
   100% of the frontend's GCIP tokens. (If you instead reuse the shared POC project, set
   `GCP_PROJECT_ID=scopeball-registry-poc-g` in **all three** places consistently.)
2. **Billing approval** (`CONFIRM_COSTS=yes`) after reading the estimate below.

## 1. Cost estimate (asia-northeast3 / Seoul, approximate)

Always-on monthly cost if the stack is left running. Figures are order-of-magnitude — confirm
in the [GCP Pricing Calculator](https://cloud.google.com/products/calculator) for the exact
region/SKU before approving.

| Resource | Config (from setup script) | ~Monthly (always-on) | Notes |
|---|---|---|---|
| **Memorystore Redis** | basic, 1 GB | **~$36** | Largest line item; `~$0.049/GB-hr × 730`. Bills 24/7 even idle. No SLA on basic. |
| **Serverless VPC connector** | 2–3 × e2-micro | **~$12–18** | `min-instances 2, max 3`; ~$6/e2-micro-mo. Bills 24/7 even idle. |
| **Cloud SQL** | db-f1-micro PG16, ZONAL, 10 GB SSD | **~$10–13** | Shared-core, no SLA/CUD. Instance ~$8–10 + storage ~$1.7 + backups. |
| **Cloud Run** | min 0 / max 2 | **~$0 idle** | Scales to zero; pay per request. Negligible for demo traffic. |
| **Artifact Registry** | 1 Rust image (~1–2 GB) | ~$0.20 | $0.10/GB-mo storage. |
| **GCS artifact bucket** | zk build_* (tens of MB) + versioning | <$0.10 | |
| **Secret Manager** | ~8 secrets | ~$0.50 | $0.06/active version-mo + access ops. |
| **Cloud Build** | Rust image build (infrequent) | ~$0 | 120 free build-min/day; Rust compile is long but infrequent. |
| **GCIP / Identity Platform** | small import, < 50k MAU | $0 | Free below 50k MAU (no multi-tenancy). |
| **Total (always-on)** | | **~$60–70/mo** | Dominated by Redis + VPC connector + Cloud SQL (~$58–67), all 24/7. |

**Cost lever for academic/demo use:** Memorystore, the VPC connector, and Cloud SQL bill around
the clock regardless of traffic; Cloud Run scales to zero. For a demo/coursework cadence, prefer
**stand-up → demo → tear-down** (delete the Redis instance, VPC connector, and Cloud SQL instance
when idle) to drop idle burn from ~$60/mo toward ~$0. Re-running the idempotent setup re-creates
them; the Cloud SQL data survives if you keep the instance, or re-runs the ETL if you don't.

## 2. Ordered standup sequence (idempotent; each step re-runnable)

> The exact env/flags for each cost-gated command live in the cited scripts. This is the order;
> the scripts enforce the `CONFIRM_COSTS=yes` gate.

1. **Create + select the project** (per the §0 decision) and link billing:
   `gcloud projects create <PROJECT_ID>` (skip if reusing shared POC) → `gcloud config set project <PROJECT_ID>`.
2. **Infra standup** — `CONFIRM_COSTS=yes … scripts/gcp/zkvote-staging-setup.sh`
   (enables APIs incl. `identitytoolkit`; creates GCS bucket, runtime SA + per-secret IAM, Cloud SQL
   PG16 + two DB users, Memorystore, VPC connector; writes the DB/redis/bucket secrets).
3. **Provision GCIP** (separate, cost/approval-gated): enable Identity Platform in the GCIP console
   for `<PROJECT_ID>`, add the **Google** provider + email/password with email-verification, set the
   authorized domains. (The setup script only enables the *API*, not the tenant/providers.)
4. **Repoint auth secrets to GCIP values** (the footgun — verify each):
   - `zkvote-staging-supabase-jwks-url` = `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`
     (the securetoken JWK endpoint — **not** the x509 PEM endpoint, **not** a Supabase URL).
   - The issuer/audience are set as **env** by `deploy-staging-api.sh` from `<PROJECT_ID>` — no secret needed.
5. **Seed proving artifacts into GCS** — now AUTOMATED: `zkvote-staging-setup.sh` invokes
   `scripts/gcp/seed-artifacts.sh`, which uploads `zk/build_4_5` + `zk/build_5_4` byte-for-byte to
   `gs://<bucket>/build_{depth}_{candidates}/{circuit_final.zkey, verification_key.json,
   VoteCheck_temp_js/VoteCheck_temp.wasm}` (the keys `read_gcs_artifact` serves) and sha256
   round-trip-verifies each (invariant #7). Re-runnable standalone:
   `CONFIRM_COSTS=yes GCP_PROJECT_ID=<id> bash scripts/gcp/seed-artifacts.sh`.
6. **Import users to GCIP** (cost-gated) — `CONFIRM_COSTS=yes GCIP_PROJECT_ID=<PROJECT_ID>
   GOOGLE_APPLICATION_CREDENTIALS=<gitignored-admin.json> SOURCE_DATABASE_URL=<supabase>
   node scripts/migration/import-users-to-gcip.js` (run `--dry-run` first; uid=UUID, BCRYPT, actual
   emailVerified — invariant #8).
7. **Build + deploy the API** — `CONFIRM_COSTS=yes CORS_ALLOWED_ORIGINS=<staging-frontend-origin>
   OWNER_PRIVATE_KEY_SECRET=zkvote-staging-owner-private-key … scripts/gcp/deploy-staging-api.sh`
   (Cloud Build → Artifact Registry → `gcloud run deploy` with Cloud SQL attach, VPC connector,
   secret mounts, GCIP issuer/audience env).
8. **Verify (Phase 18 gate):** `/healthz` + `/readyz` 200; effective issuer == `securetoken.google.com/<PROJECT_ID>`
   (not a derived Supabase value); a GCIP token is accepted and a Supabase token is rejected; a voter
   fetches wasm/zkey from GCS and the sha256 matches the manifest; secret access scoped to `zkvote-staging-*`;
   no `main` push triggers a live AWS deploy.

## Audit remediations

From the 2026-06-21 adversarial audit (`phase18-22-rollout-audit` workflow: 44 findings, 13 upheld
+ 2-lens refute-by-default verification, 1 contested→dismissed, 27 low/info). All confirmed
execution-blockers are now fixed in-tree; the cost-gated execution itself is unchanged.

**Execution-blockers (must-fix) — FIXED:**

- **GCS bucket never seeded → 100% proof 404** (high). `zkvote-staging-setup.sh` now invokes the new
  `scripts/gcp/seed-artifacts.sh` (idempotent, sha256 round-trip-verified, invariant #7) right after
  the bucket is created.
- **JWKS/RPC secrets had no enabled version → `--set-secrets ...:latest` deploy abort** (medium).
  Setup now writes the JWKS secret **unconditionally** to the fixed GCIP endpoint (with an
  empty-string guard, since `config.rs:117` does not filter empty), and **fails fast** if
  `zkvote-staging-sepolia-rpc-url` has no enabled version.
- **Project-id mismatch → 100% token rejection** (high). Setup/deploy defaults moved off the shared
  POC project to a dedicated `zkvote-staging`; `.env.example` + `PRODUCTION_READINESS.md` reconciled.
  The frontend-Firebase == GCIP == Cloud Run == audience equality is now the §0 decision gate and the
  §8 verification gate.
- **Rollback was auth-incompatible** (high). `RUNBOOK_CUTOVER.md` rollback is now the full
  three-artifact restore (Node image + Supabase-auth frontend build + Supabase data) with a sign-in
  check; the forward GCIP auth cut-over step was also added.
- **PRODUCTION_READINESS said prod does NOT mount the OWNER key** (high) — but `finalize.rs:219-223`
  fails closed (503) without it. Corrected: prod mounts a **separate cold** owner key (AR-M4 means
  owner ≠ relayer, not owner-absent).

**Lower-severity — FIXED:**

- Runtime SA bucket role `objectAdmin` → `objectViewer` (least-privilege; the API only GETs).
- ETL: `voters.email` NOT-NULL pre-flight guard; stale `@file` phase number + dead `server/.env` path.
- `PROJECT_PLAN §18/§20` stale text reconciled (the already-done SUPABASE_URL drop, the now-existing
  seed step, the vendored migration `require` paths); `PRODUCTION_READINESS` got the prod-GCIP +
  §0.5 chain-guard sections + the GCIP sign-in-failure alert; stale phase numbers fixed in both runbooks.
- Phase-20 identity cross-check (`voters.user_id`/`admins.id` set == GCIP uid set) is now an explicit
  operator gate in `RUNBOOK_CUTOVER.md` step 3 (it was a silent gap; the ETL does not contact GCIP).

**Dismissed (verified non-issue):**

- "ETL drops `admin_invitations` consumed-state → re-enables used admin promotions" — **refuted by
  both verifiers.** `admin_invitations` has no consumed-state column the ETL could drop (PK `email`
  + nullable `accepted_by`); consumption is the existence of the `admins` row, which the ETL copies.

**Deferred (non-blocking, noted not fixed):** Cloud SQL staging deletion-protection left OFF on
purpose (teardown is the cost lever; prod gets it); `google-github-actions/auth@v2` not yet
SHA-pinned in `deploy-frontend-firebase.yml` (minor supply-chain hardening, AR-H8 spirit).

## Sources (pricing)

- [Google Cloud SQL pricing](https://cloud.google.com/sql/pricing) · [usage.ai 2026 guide](https://www.usage.ai/blogs/gcp/cloud-sql/pricing/)
- [Memorystore for Redis pricing](https://cloud.google.com/memorystore/docs/redis/pricing) · [dragonflydb guide](https://www.dragonflydb.io/guides/google-cloud-redis-pricing)
- [Serverless VPC Access](https://docs.cloud.google.com/vpc/docs/serverless-vpc-access) · [e2-micro pricing](https://www.economize.cloud/resources/gcp/pricing/compute-engine/e2-micro/)
