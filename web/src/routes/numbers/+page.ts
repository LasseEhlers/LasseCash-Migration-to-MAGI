// A link-card stand-in for /stats, for sharing on X and in chats.
//
// /stats is client-only (it reads ~1,700 state keys; see its +page.ts), so its
// HTML carries no meta tags and a link to it unfurls as bare text. This page is
// prerendered WITH the tags and sends a person straight on to /stats. It is not
// a copy of anything: it holds no figures, so it can never go stale.
export const prerender = true;
