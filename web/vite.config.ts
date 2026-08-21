import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: { fs: { allow: [".."] } },
  // PUBLIC_ is exposed alongside Vite's own VITE_ prefix so that
  // PUBLIC_SITE_URL — the single origin every canonical URL, sitemap entry and
  // JSON-LD id is built from — is readable from both server and browser code
  // without a second mechanism. See src/lib/site.ts.
  envPrefix: ["VITE_", "PUBLIC_"],
});
