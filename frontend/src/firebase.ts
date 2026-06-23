/**
 * @file frontend/src/firebase.ts
 * @desc Firebase Auth (GCP Identity Platform) client init — replaces the legacy
 * Supabase Auth client (PROJECT_PLAN Phase 16).
 *
 * The Firebase web `apiKey` is PUBLIC client config, not a secret — it only
 * identifies the project to Google's auth endpoints; access is governed by the
 * provider/identity rules and the backend's JWT verification, not by this key.
 * So these VITE_FIREBASE_* values ship in the client bundle by design.
 */
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

// Fail fast on a misconfigured build: a bundle built without VITE_FIREBASE_* (e.g.
// a CD job still injecting the old REACT_APP_* names) would otherwise initialize
// Firebase with apiKey:undefined and fail opaquely at the first sign-in.
const missingFirebaseConfig = (['apiKey', 'authDomain', 'projectId'] as const).filter(
  (key) => !firebaseConfig[key],
);
if (missingFirebaseConfig.length > 0) {
  throw new Error(
    `Missing Firebase config: ${missingFirebaseConfig.join(', ')}. Set the VITE_FIREBASE_* ` +
      'build-time env (see frontend/.env.example); a build without them cannot authenticate.',
  );
}

// (mirrors the old supabase.js debug: confirm config is wired, never log the key)
console.log('Firebase projectId:', firebaseConfig.projectId);

const app = initializeApp(firebaseConfig);

// The GCIP/Firebase Auth instance. Token retrieval is async:
// `await auth.currentUser.getIdToken()` (see api/axios.ts).
export const auth = getAuth(app);
