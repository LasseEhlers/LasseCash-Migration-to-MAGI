/// <reference types="@sveltejs/kit" />

declare global {
  namespace App {
    // Cloudflare bindings. DB is the transaction index (D1), bound in the
    // Pages dashboard as "DB"; optional because the site must work without
    // it — every reader falls back to walking the node.
    interface Platform {
      env?: { DB?: import("$lib/server/tx-index").D1Like };
    }
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
