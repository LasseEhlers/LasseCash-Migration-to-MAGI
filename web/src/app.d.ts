/// <reference types="@sveltejs/kit" />

declare global {
  namespace App {
    // Cloudflare's platform bindings would go here if the app ever needed one.
    // It does not: the worker reads the chain over fetch and holds no state.
  }
}

/**
 * Markdown imported at BUILD time.
 *
 * Vite's `?raw` suffix inlines a file as a string. It is how `docs/ABOUT.md`
 * reaches the edge worker at all — there is no filesystem to read from at
 * request time, and there must be exactly one copy of that text.
 */
declare module "*.md?raw" {
  const content: string;
  export default content;
}

export {};
