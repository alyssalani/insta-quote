import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages project sites are served from https://<user>.github.io/<repo>/,
// so the build needs to know that "/<repo>/" prefix. The deploy workflow sets
// VITE_BASE to the repo name automatically; for local dev it just falls back
// to "/". If you deploy somewhere else (Netlify, Vercel, a custom domain, a
// user/organization site at the root of github.io), set VITE_BASE to "/".
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || "/",
});
