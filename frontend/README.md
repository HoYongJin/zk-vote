# zk-vote frontend

React 19 single-page app (TypeScript) for the zk-vote anonymous voting system. Admins
create and finalize elections; voters register, generate a zero-knowledge proof **in the
browser**, and submit it anonymously. Built with **Vite 7 + TypeScript** (migrated off
Create React App).

## Architecture

- **Auth:** Firebase Auth / GCP Identity Platform (`firebase` web SDK) for login/session.
  Role (admin vs voter) is resolved server-side via `GET /api/me` — the frontend does **not**
  read role tables directly (audit AR-H4). See `src/firebase.ts`, `src/App.tsx`.
- **State:** Redux Toolkit (`src/store/authSlice.ts`); only a serializable `{ uid, email }`
  projection of the Firebase user is stored. Typed hooks in `src/store/hooks.ts`.
- **API client:** `src/api/axios.ts`; base URL from `src/utils/apiBaseUrl.ts`. The interceptor
  attaches the Firebase ID token, except on requests flagged `{ skipAuth: true }` (the
  anonymous `/submit` call must carry no JWT).
- **Client-held voter secret (audit H2):** `src/utils/voterSecret.ts` generates the voter's
  31-byte secret (`crypto.getRandomValues`) and keeps it in per-election `localStorage`. The
  server only ever receives the Poseidon commitment `H(secret)` (via `poseidon-lite`) — never
  the secret itself.
- **Browser proof generation:** `src/workers/proof.worker.ts` runs snarkjs Groth16 proving in
  an **ES-module Web Worker**, so the secret never leaves the client. Proving artifacts
  (`.wasm`/`.zkey`) are fetched and SHA-256 integrity-checked against the deploy manifest before
  proving (`src/utils/artifactIntegrity.ts`, AR-M6) — the browser refuses to prove on mismatch.
- **Submission jitter (audit AR-M2):** `src/utils/submissionJitter.ts` adds TTL-safe timing
  jitter to reduce `/proof`→`/submit` timing correlation.

## Routes

| Path | Guard | Page |
|---|---|---|
| `/login` | public | `src/pages/LoginPage.tsx` |
| `/admin` | `AdminRoute` | `src/pages/Admin/AdminMainPage.tsx` |
| `/admin/create` | `AdminRoute` | `src/pages/Admin/CreateVotePage.tsx` |
| `/` (voter home) | `ProtectedRoute` | `src/pages/Voter/VoterMainPage.tsx` |
| `/vote/:id` | `ProtectedRoute` | `src/pages/Voter/VotePage.tsx` |

## Environment

Vite inlines **only `VITE_`-prefixed** env (`import.meta.env`) at build time. Copy
`.env.example` to `.env` and fill in (all values are PUBLIC client config — no secrets):

```
VITE_API_BASE_URL=http://localhost:8080/api   # backend API base; defaults to "/api" if unset
VITE_FIREBASE_API_KEY=<firebase web api key>
VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<project-id>
VITE_CHAIN_EXPLORER_BASE_URL=https://sepolia.etherscan.io
```

`src/firebase.ts` fails fast (throws) if the Firebase values are missing, so a misconfigured
build cannot silently ship a broken-auth bundle.

## Scripts

```bash
npm install
npm run dev         # Vite dev server on :3000 (proxies /api → http://localhost:8080)
npm run typecheck   # tsc --noEmit for src + vite.config.ts
npm run lint        # eslint (incl. react-hooks/exhaustive-deps)
npm test            # vitest run (CI mode; non-watch)
npm run build       # typecheck + production bundle → build/
npm run preview     # serve the production build locally
```

Requires Node ≥ 20.19 (Vite 7).

## Hosting

Primary target is **Firebase Hosting** (`../firebase.json`, deployed together with the
API by `.github/workflows/deploy-production.yml`): SPA fallback to `index.html`, content-hashed
`/assets/**` cached immutably, `index.html` no-cache, and a security-header/CSP baseline tuned
for the WASM proving worker + Firebase Auth popups. (The legacy AWS S3/CloudFront CD
was removed.) The deployed origin must be allowed in the Cloud Run `CORS_ALLOWED_ORIGINS`.

## Notes

- The Merkle-depth selector supports the provisioned `{4,6,8,10}` depths with verifier width
  10. Different depth/width combinations require generating and registering new artifacts.
- The main bundle (~1 MB, mostly Firebase) is above Vite's 500 kB warning; snarkjs already
  lazy-loads in the worker chunk. Code-splitting Firebase is a possible future optimization.
