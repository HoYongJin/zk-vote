/**
 * @file frontend/src/firebase.js
 * @desc Firebase Auth (GCP Identity Platform) client init — replaces the legacy
 * Supabase Auth client (PROJECT_PLAN Phase 16).
 *
 * The Firebase web `apiKey` is PUBLIC client config, not a secret — it only
 * identifies the project to Google's auth endpoints; access is governed by the
 * provider/identity rules and the backend's JWT verification, not by this key.
 * So these REACT_APP_FIREBASE_* values ship in the client bundle by design.
 */
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
};

// --- debug (mirrors the old supabase.js: confirm config is wired, never log the key) ---
console.log('Firebase projectId:', firebaseConfig.projectId);
console.log('Is Firebase API key loaded?:', Boolean(firebaseConfig.apiKey));

const app = initializeApp(firebaseConfig);

// The GCIP/Firebase Auth instance. Token retrieval is async:
// `await auth.currentUser.getIdToken()` (see api/axios.js).
export const auth = getAuth(app);
