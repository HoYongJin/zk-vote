# zk-vote frontend

React (19) single-page app for the zk-vote anonymous voting system. Admins create and
finalize elections; voters register, generate a zero-knowledge proof **in the browser**,
and submit it anonymously. Built with Create React App (`react-scripts` 5).

## Architecture

- **Auth:** Supabase Auth (`@supabase/supabase-js`) for login/session. Role (admin vs voter)
  is resolved server-side via `GET /api/me` — the frontend does **not** read role tables
  directly (audit AR-H4).
- **State:** Redux Toolkit (`store/authSlice.js`).
- **API client:** `src/api/axios.js`; base URL comes from `src/utils/apiBaseUrl.js` so the
  target backend (Node today, Rust after cutover) is switchable via env.
- **Client-held voter secret (audit H2):** `src/utils/voterSecret.js` generates the voter's
  secret and keeps it in per-election `localStorage`. The server only ever receives the
  Poseidon commitment `H(secret)` (via `poseidon-lite`) — never the secret itself.
- **Browser proof generation:** `src/workers/proof.worker.js` runs snarkjs Groth16 proving in
  a Web Worker, so the secret never leaves the client. Proving artifacts (`.wasm`/`.zkey`)
  are fetched from the backend and integrity-checked (`src/utils/artifactIntegrity.js`).
- **Submission jitter (audit AR-M2):** `src/utils/submissionJitter.js` adds TTL-safe timing
  jitter to reduce `/proof`→`/submit` timing correlation.

## Routes

| Path | Guard | Page |
|---|---|---|
| `/login` | public | `pages/LoginPage.js` |
| `/admin` | `AdminRoute` | `pages/Admin/AdminMainPage.js` |
| `/admin/create` | `AdminRoute` | `pages/Admin/CreateVotePage.js` |
| `/` (voter home) | `ProtectedRoute` | `pages/Voter/VoterMainPage.js` |
| `/vote/:electionId` | `ProtectedRoute` | `pages/Voter/VotePage.js` |

## Environment

Create `frontend/.env` (Create React App only exposes `REACT_APP_*` vars):

```
REACT_APP_API_BASE_URL=http://localhost:3001    # backend API base (Node today / Rust after cutover)
REACT_APP_SUPABASE_URL=https://<project>.supabase.co
REACT_APP_SUPABASE_ANON_KEY=<anon-key>
```

## Scripts

```bash
npm install
npm start                       # dev server (proxies to REACT_APP_API_BASE_URL)
npm test -- --watchAll=false    # CI mode (mirrors GitHub Actions)
npm run build                   # production bundle
```

## Hosting

The committed CD (`buildspec.yml`, `.github/workflows/deploy-frontend.yml`) deploys to
**legacy AWS S3/CloudFront**. The backend is migrating to GCP; the post-cutover frontend
hosting target is an **open decision** (see `../docs/TECH_STACK.md` §6). Whatever origin is
chosen must be allowed in the Cloud Run `CORS_ALLOWED_ORIGINS`.

## Notes

- The Merkle-depth selector currently supports depth 2–5 (the provisioned ZK artifacts);
  larger trees require generating new circuits + ptau (see root `README.md`).
- `src/setupProxy.js` is dead/commented-out and references an obsolete dev target — ignore it.
