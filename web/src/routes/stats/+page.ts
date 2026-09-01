// UNLINKED, NOT SECRET.
//
// Every figure here is public on chain and the Snapshot page already publishes
// the full migration set on purpose. This page is unlinked because the nav is
// already ten items long and a leaderboard is not a primary action — not
// because the data is sensitive. `noindex` keeps it out of search results so it
// stays something you hand someone rather than something they stumble into.
//
// Client-only: it reads ~840 state keys and the whole transaction log, which is
// far too much work for a Cloudflare worker to do on every request.
export const ssr = false;
export const prerender = false;
