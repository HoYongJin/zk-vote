/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL. Defaults to "/api" when unset (see utils/apiBaseUrl). */
  readonly VITE_API_BASE_URL?: string;
  /**
   * Firebase / GCP Identity Platform web config (public client config). Optional
   * at the type level because a build without them yields `undefined` — firebase.ts
   * fails fast in that case rather than silently shipping a broken-auth bundle.
   */
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_CHAIN_EXPLORER_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
