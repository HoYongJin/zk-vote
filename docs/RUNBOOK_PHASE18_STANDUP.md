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

## 1. Cost estimate — minimal / free-tier config (asia-northeast3, approximate)

`zkvote-staging-setup.sh` now defaults every resource to its cheapest floor (db-f1-micro **HDD**,
**no automated backups**, Memorystore basic 1 GB, VPC connector **2 × e2-micro** min, Cloud Run
**min 0 / max 1**). All specs are env-overridable for prod (see `PRODUCTION_READINESS.md`). Confirm
in the [GCP Pricing Calculator](https://cloud.google.com/products/calculator) before approving.

| Resource | Minimal config | ~Monthly | Free tier? |
|---|---|---|---|
| **Memorystore Redis** | basic, 1 GB | **~$36** | ❌ no free tier; 1 GB basic is the smallest managed Redis |
| **Serverless VPC connector** | 2 × e2-micro (floor) | **~$12** | ❌ needed only for Memorystore's private IP |
| **Cloud SQL** | db-f1-micro, HDD, 10 GB, no-backup, ZONAL | **~$8** | ❌ no free tier; cheapest shared-core tier |
| **Cloud Run** | min 0 / max 1 | **~$0** | ✅ scales to zero; 2M req + 360k GB-s/mo free |
| Artifact Registry / GCS / Secret Manager / Cloud Build / GCIP | minimal | **~$0–1** | ✅ mostly within always-free |
| **Total (always-on, managed)** | | **~$56/mo** | — |

**Free-trial note:** a new GCP account's **$300 / 90-day** trial credit covers this ~$56/mo stack for
the full trial (~$168 over 90 days) — effectively free for a time-boxed demo/course; after the trial
it bills at ~$56/mo. Teardown (delete Redis + connector + Cloud SQL when idle) drops it toward ~$0;
the idempotent setup re-creates them on the next run.

### Cost minimization — getting below the ~$48 managed floor

Memorystore ($36) + the VPC connector ($12) are the **irreducible floor** in the managed
architecture (no smaller managed Redis tier exists). The app uses Redis only for submission tickets +
finalize/deploy locks, so moving Redis off Memorystore reaches **~$8/mo or near-$0**.

**This is now WIRED via a `REDIS_BACKEND` toggle** (no code change needed to switch):
- `REDIS_BACKEND=memorystore` (default) — creates Memorystore + the VPC connector; deploy attaches `--vpc-connector`.
- `REDIS_BACKEND=external` — **skips Memorystore AND the VPC connector**; you supply a `REDIS_URL`
  (the setup writes it to the `zkvote-staging-redis-url` secret, refusing if absent), and the deploy
  omits `--vpc-connector`. Cloud SQL is still reached via `--add-cloudsql-instances`.

Set the SAME `REDIS_BACKEND` on both `zkvote-staging-setup.sh` and `deploy-staging-api.sh`. Two ways
to provide the external Redis:

- **Option A — Upstash Redis (serverless, free tier):** a public `rediss://` endpoint (free ≈ 10k
  cmds/day). `REDIS_BACKEND=external REDIS_URL=rediss://...upstash.io:6379 …`. → **~$8/mo** (Cloud SQL
  only). Least ops; third-party dependency, fine for demo/staging.
- **Option B — Redis on a free e2-micro Compute Engine VM:** always-free e2-micro (us-central1 /
  us-west1 / us-east1 only) running Redis 7; `REDIS_BACKEND=external REDIS_URL=redis://<vm-ip>:6379`.
  → **~$8–12/mo**. More ops/security surface (lock the VM down to the Cloud Run egress).
- **Option C — keep managed, accept ~$56/mo** (`REDIS_BACKEND=memorystore`, the default; simplest,
  covered by the free-trial credit).

## 2. Ordered standup sequence (idempotent; each step re-runnable)

> The exact env/flags for each cost-gated command live in the cited scripts. This is the order;
> the scripts enforce the `CONFIRM_COSTS=yes` gate.

**Rehearse first (free, no auth):** preview the exact resolved provisioning with your own values —
`DRY_RUN=yes GCP_PROJECT_ID=<id> REDIS_BACKEND=external REDIS_URL=rediss://… bash scripts/gcp/zkvote-staging-setup.sh`
prints the full plan (project, bucket, Cloud SQL specs, Redis topology, secrets, ordered actions) and
exits without a single GCP call, cost, or authentication. Confirm it reads right, then drop `DRY_RUN`.

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
8. **Verify (Phase 18 gate)** — run `scripts/gcp/verify-staging.sh` (read-only, no cost):
   `STAGING_BASE_URL=<cloud-run-url> [GCIP_ID_TOKEN=..] [SUPABASE_ID_TOKEN=..] bash scripts/gcp/verify-staging.sh`.
   It asserts `/healthz` + `/readyz` 200; every proving artifact GETs 200 **and is byte-identical to the
   committed `zk/` bytes** (invariant #7 — proves the bucket was seeded right); and, when sample tokens
   are supplied, that a GCIP token is **accepted** and a stale Supabase token is **rejected** (proves the
   issuer/audience repoint). Manually also confirm secret access is scoped to `zkvote-staging-*` and no
   `main` push triggers a live AWS deploy.

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
