import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    // Static build: the frontend is a pure client of the chain. There is no
    // server-side secret and nothing to render server-side that the chain has
    // not already computed.
    adapter: adapter({ fallback: "index.html" }),
    alias: { "$api": "../api/src" },
  },
};
