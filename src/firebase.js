import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// All values come from environment variables (see .env.example) so real
// credentials never get committed to the repo. Vite only exposes vars that
// start with VITE_ to client code, and it's safe for these Firebase web
// config values to end up in the shipped JS bundle — they identify your
// project, they aren't secret keys. Access is controlled by Firestore
// Security Rules (see firestore.rules), not by hiding this config.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const missing = Object.entries(firebaseConfig)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  // Fails loudly and early instead of letting every storage call silently
  // no-op, which is a confusing way to discover a missing .env file.
  console.error(
    `Missing Firebase config values: ${missing.join(", ")}. ` +
    `Copy .env.example to .env and fill in your Firebase project's web config.`
  );
}

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);
